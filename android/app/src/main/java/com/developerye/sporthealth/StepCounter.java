package com.developerye.sporthealth;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Handler;
import android.os.HandlerThread;

import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.Date;
import java.util.Locale;

/**
 * 原生计步核心：在 Java 侧常驻监听两个系统传感器，并自己维护「今日步数」。
 *
 * 为什么要搬到原生（原来在 src/utils/health.js 里用 plus.android.implements 做）：
 *   1. 原来监听器是**实现在 JS 引擎里**的 Java 接口 —— 每次传感器回调都要跨 Java→JS 一层。
 *      WebView 忙（地图渲染/滚动）或 JS 线程被系统冻结时，回调会丢或延迟。
 *   2. 进程被杀后 JS 监听器直接消失，detector 累计清零。
 *   3. 每次读取都「注册→等首值→3 秒超时」，超时就返回 -1，界面显示 0（看起来像失灵）。
 * 现在：Java 侧监听 + SharedPreferences 落盘，JS 只读一个数字，毫秒级返回。
 *
 * 两路传感器的分工（与厂商健康 App 读的是同一批硬件）：
 *   - TYPE_STEP_COUNTER(19)：开机以来累计，精度高，但很多机型息屏后会冻结；
 *   - TYPE_STEP_DETECTOR(18)：每落一步一个事件，实时，可能漏计。
 * 今日步数 = max( 计步器增量 , 检测器增量 )，任一失效另一路顶上。
 *
 * 每日基线（这是"准不准"的关键）：
 *   - 首装            → base = 0（开机累计全额算今天）
 *   - 正常跨天        → base = min(昨日末值, 当前读数)
 *   - 跨天且手机重启过 → 同上，min 会取到重启后的小值，不会把今天算成 0
 *   - 隔多天没开 App   → base = 当前读数（从此刻起算，绝不把几天算成今天）
 *   外加 offset：同一天内手机重启（counter 归零）时把重启前的量补回来。
 *
 * 跨天时机的精度由 StepMidnightReceiver 的每日 00:00:30 闹钟保证 —— 那一刻读到的
 * counter 才真正接近「零点累计值」；否则要等用户下次开 App 才滚动，会多算零点前那段。
 */
public final class StepCounter implements SensorEventListener {

    private static final String PREFS = "fh_step_native";
    private static final String K_DATE = "date";
    private static final String K_BASE = "base";
    private static final String K_LAST = "lastRaw";
    private static final String K_DET_BASE = "detBase";
    private static final String K_DET_TOTAL = "detTotal";
    private static final String K_OFFSET = "offset";
    private static final String K_LAST_KNOWN = "lastKnown";

    private static final long PERSIST_GAP_MS = 3000L;

    private static volatile StepCounter instance;

    private final Context app;
    private final SharedPreferences sp;

    private SensorManager sm;
    private HandlerThread thread;
    private Handler worker;

    /** 传感器最新读数（-1 = 还没收到） */
    private volatile long counter = -1L;
    /** 检测器事件累计（跨进程重启从持久值续上，不要清零） */
    private volatile long detTotal = 0L;
    private volatile long counterEvents = 0L;
    private volatile long detEvents = 0L;
    private volatile boolean registered = false;
    private volatile String err = "";

    /** 落盘的当日状态镜像（避免每条事件都读 SharedPreferences） */
    private volatile String fDate = "";
    private volatile long fBase = -1L;
    private volatile long fLastRaw = -1L;
    private volatile long fDetBase = 0L;
    private volatile long fOffset = 0L;
    private volatile long lastPersistAt = 0L;

    private StepCounter(Context ctx) {
        Context c = ctx;
        try {
            Context ac = ctx.getApplicationContext();
            if (ac != null) c = ac;
        } catch (Throwable t) {
            // 拿不到 applicationContext 就退回传入的 Context
        }
        this.app = c;
        this.sp = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        try {
            fDate = sp.getString(K_DATE, "");
            fBase = sp.getLong(K_BASE, -1L);
            fLastRaw = sp.getLong(K_LAST, -1L);
            fDetBase = sp.getLong(K_DET_BASE, 0L);
            fOffset = sp.getLong(K_OFFSET, 0L);
            detTotal = sp.getLong(K_DET_TOTAL, 0L);
        } catch (Throwable t) {
            err = "load:" + t;
        }
    }

    public static StepCounter get(Context ctx) {
        StepCounter c = instance;
        if (c != null) return c;
        synchronized (StepCounter.class) {
            if (instance == null) instance = new StepCounter(ctx);
            return instance;
        }
    }

    // ===== 供 JS 桥调用的静态入口 =====

    /** 注册监听（幂等）。返回是否至少注册成功一路。 */
    public static boolean start(Context ctx) {
        try {
            return get(ctx).startInternal();
        } catch (Throwable t) {
            return false;
        }
    }

    /** 今日步数；-1 表示两路都还没就绪（调用方应沿用上次值，不要显示 0） */
    public static int getTodaySteps(Context ctx) {
        try {
            return get(ctx).stepsNow();
        } catch (Throwable t) {
            return -1;
        }
    }

    /**
     * 两路原始读数，返回 JSON 字符串（避免 JS 侧解析数组）。
     * 形如 {"counter":1234,"det":56,"ok":true,"err":""}
     */
    public static String getBranchesJson(Context ctx) {
        StepCounter sc = get(ctx);
        boolean ok = sc.counter >= 0L || sc.detEvents > 0L;
        return "{\"counter\":" + sc.counter
                + ",\"det\":" + sc.detTotal
                + ",\"ok\":" + (ok ? "true" : "false")
                + ",\"err\":\"" + escape(sc.err) + "\"}";
    }

    /** 诊断信息（真机排查用） */
    public static String getDiagJson(Context ctx) {
        StepCounter sc = get(ctx);
        return "{\"registered\":" + (sc.registered ? "true" : "false")
                + ",\"counter\":" + sc.counter
                + ",\"det\":" + sc.detTotal
                + ",\"cb\":" + sc.counterEvents
                + ",\"ev\":" + sc.detEvents
                + ",\"base\":" + sc.fBase
                + ",\"lastRaw\":" + sc.fLastRaw
                + ",\"offset\":" + sc.fOffset
                + ",\"date\":\"" + escape(sc.fDate) + "\""
                + ",\"err\":\"" + escape(sc.err) + "\"}";
    }

    /** 每天零点后由闹钟调用：促使状态滚动到新的一天（此时 counter 最接近零点值） */
    public static void rolloverNow(Context ctx) {
        try {
            get(ctx).stepsNow();
            get(ctx).persist(true);
        } catch (Throwable t) {
            // 闹钟链路失败不能影响主流程
        }
    }

    /**
     * 确保计步服务在跑（JS 桥在 App 启动/回前台时调用）。
     * 顺带排上零点闹钟 —— 两者都在这里做，JS 侧只需要一次调用。
     */
    public static void ensureService(Context ctx) {
        try {
            ctx.startService(new Intent(ctx, StepTrackService.class));
        } catch (Throwable t) {
            // 后台启动可能被系统拒绝；不影响读取（读取会当场注册监听）
        }
        try {
            StepScheduler.scheduleMidnight(ctx);
        } catch (Throwable t) {
            // 忽略
        }
    }

    // ===== 监听器 =====

    private boolean startInternal() {
        if (registered) return true;
        try {
            sm = (SensorManager) app.getSystemService(Context.SENSOR_SERVICE);
            if (sm == null) {
                err = "no-sensor-manager";
                return false;
            }
            thread = new HandlerThread("fh-step");
            thread.start();
            worker = new Handler(thread.getLooper());

            boolean a = false;
            boolean b = false;
            Sensor cs = sm.getDefaultSensor(Sensor.TYPE_STEP_COUNTER);
            if (cs != null) {
                a = sm.registerListener(this, cs, SensorManager.SENSOR_DELAY_NORMAL, worker);
            } else if (err.length() == 0) {
                err = "no-counter";
            }
            Sensor ds = sm.getDefaultSensor(Sensor.TYPE_STEP_DETECTOR);
            if (ds != null) {
                b = sm.registerListener(this, ds, SensorManager.SENSOR_DELAY_NORMAL, worker);
            } else if (err.length() == 0) {
                err = "no-detector";
            }
            registered = a || b;
            if (!registered && err.length() == 0) err = "register-failed";
            return registered;
        } catch (Throwable t) {
            err = "start:" + t;
            return false;
        }
    }

    @Override
    public void onSensorChanged(SensorEvent event) {
        try {
            if (event == null || event.sensor == null || event.values == null || event.values.length == 0) {
                return;
            }
            int type = event.sensor.getType();
            if (type == Sensor.TYPE_STEP_COUNTER) {
                counterEvents++;
                long v = (long) event.values[0];
                if (v >= 0L) {
                    counter = v;
                    maybePersist(false);
                }
            } else if (type == Sensor.TYPE_STEP_DETECTOR) {
                detEvents++;
                detTotal++;
                maybePersist(false);
            }
        } catch (Throwable t) {
            err = "event:" + t;
        }
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {
        // 不需要处理
    }

    // ===== 今日步数解算 =====

    private int stepsNow() {
        long steps = computeSteps();
        if (steps < 0L) {
            // 两路都还没就绪：返回上次已知值，避免界面闪成 0
            return (int) Math.max(0L, sp.getLong(K_LAST_KNOWN, 0L));
        }
        int out = (int) Math.min(999999L, steps);
        try {
            sp.edit().putLong(K_LAST_KNOWN, out).apply();
        } catch (Throwable t) {
            // ignore
        }
        persist(false);
        return out;
    }

    private long computeSteps() {
        String today = todayStr();
        boolean newDay = !today.equals(fDate);

        if (newDay) {
            long base;
            if (fLastRaw < 0L) {
                base = 0L; // 首装：开机累计全额算今天
            } else if (counter < 0L) {
                base = fLastRaw; // 传感器暂无值：沿用上次末值
            } else if (daysBetween(fDate, today) > 1) {
                base = counter; // 隔多天没开：从此刻起算，绝不虚增
            } else {
                base = Math.min(fLastRaw, counter); // 隔一天（含手机重启）
            }
            fBase = base;
            fDate = today;
            fDetBase = detTotal;
            fOffset = 0L;
            fLastRaw = counter >= 0L ? counter : fLastRaw;
            persist(true);
        } else {
            // 同一天：手机重启（counter 归零）要把重启前的量补回来
            if (counter >= 0L && fLastRaw >= 0L && counter < fLastRaw) {
                fOffset += fLastRaw;
            }
            if (counter >= 0L) fLastRaw = counter;
            // 检测器计数跨进程已续上；若仍回退（系统清零）则重设基线
            if (detTotal < fDetBase) fDetBase = detTotal;
        }

        if (counter < 0L && detTotal <= 0L) return -1L;

        long cDelta = fOffset;
        if (counter >= 0L && counter >= fBase) cDelta += counter - fBase;
        long dDelta = detTotal >= fDetBase ? detTotal - fDetBase : 0L;
        return Math.max(cDelta, dDelta);
    }

    private void maybePersist(boolean force) {
        long now = System.currentTimeMillis();
        if (!force && now - lastPersistAt < PERSIST_GAP_MS) return;
        persist(force);
    }

    private void persist(boolean sync) {
        try {
            lastPersistAt = System.currentTimeMillis();
            SharedPreferences.Editor e = sp.edit()
                    .putString(K_DATE, fDate)
                    .putLong(K_BASE, fBase)
                    .putLong(K_LAST, fLastRaw)
                    .putLong(K_DET_BASE, fDetBase)
                    .putLong(K_DET_TOTAL, detTotal)
                    .putLong(K_OFFSET, fOffset);
            if (sync) e.commit();
            else e.apply();
        } catch (Throwable t) {
            err = "persist:" + t;
        }
    }

    // ===== 工具 =====

    private static String todayStr() {
        try {
            return new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
        } catch (Throwable t) {
            return "";
        }
    }

    /** 两个 yyyy-MM-dd 之间差几天（解析失败返回 1，按"隔一天"处理最保守） */
    private static long daysBetween(String from, String to) {
        try {
            SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd", Locale.US);
            Date a = f.parse(from);
            Date b = f.parse(to);
            if (a == null || b == null) return 1L;
            long diff = b.getTime() - a.getTime();
            long days = Math.round(diff / 86400000.0);
            return days < 0L ? 1L : days;
        } catch (Throwable t) {
            return 1L;
        }
    }

    private static String escape(String s) {
        if (s == null) return "";
        return s.replace("\\", "/").replace("\"", "'").replace("\n", " ");
    }

    /** 供闹钟/开机链路计算"下一个零点后 30 秒" */
    static long nextMidnightMs() {
        Calendar c = Calendar.getInstance();
        c.add(Calendar.DAY_OF_MONTH, 1);
        c.set(Calendar.HOUR_OF_DAY, 0);
        c.set(Calendar.MINUTE, 0);
        c.set(Calendar.SECOND, 30);
        c.set(Calendar.MILLISECOND, 0);
        return c.getTimeInMillis();
    }
}

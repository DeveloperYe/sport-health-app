package com.developerye.sporthealth;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

/**
 * 每日零点闹钟：让「今日步数」的基线在 00:00 那一刻滚动，而不是等用户下次开 App。
 *
 * 为什么不靠 Service 常驻：
 *   厂商健康 App 是系统应用，24 小时在跑，零点自动快照；我们做不到（会被省电策略干掉）。
 *   但"零点快照"这件事只需要在零点醒一次 —— 用 AlarmManager 就够，进程不需要一直活着。
 *   醒来时 counter（开机累计）就在系统里，读一次、写下基线、再排明天的闹钟，然后退出。
 *
 * 精度：闹钟定在 00:00:30，读到的 counter 与真实零点值只差 30 秒的步数（通常 0~60 步），
 * 比"等用户明天开 App 才滚动"（可能多算前一晚几小时的步数）准得多。
 */
public final class StepScheduler {

    private static final int REQ = 20261121;
    private static final String ACTION = "com.developerye.sporthealth.STEP_MIDNIGHT";

    private StepScheduler() {
    }

    /** 排定下一个零点闹钟（幂等：同 PendingIntent 会被更新） */
    public static void scheduleMidnight(Context ctx) {
        try {
            AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;
            Intent i = new Intent(ctx, StepMidnightReceiver.class);
            i.setAction(ACTION);
            PendingIntent pi = PendingIntent.getBroadcast(
                    ctx, REQ, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            long at = StepCounter.nextMidnightMs();

            if (Build.VERSION.SDK_INT >= 31) {
                // Android 12+ 精确闹钟要看用户是否授予「闹钟和提醒」权限
                if (am.canScheduleExactAlarms()) {
                    am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
                } else {
                    am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
                }
            } else if (Build.VERSION.SDK_INT >= 23) {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
            } else {
                am.set(AlarmManager.RTC_WAKEUP, at, pi);
            }
        } catch (Throwable t) {
            // SecurityException（精确闹钟未授权）等都不应影响主流程
        }
    }
}

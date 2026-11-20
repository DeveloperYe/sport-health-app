package com.developerye.sporthealth;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * 零点闹钟接收器：醒来后促今日基线滚动到新的一天，并把闹钟排到明天。
 *
 * 用 goAsync() + 短等待：counter 传感器回调通常 200ms 内到，等 800ms 足够拿到
 * 「零点后的最新累计值」；拿不到也没关系，StepCounter 会退回上次末值（精度略差）。
 * 不直接 return 是为了让进程多活这几百毫秒，否则回调可能来不及。
 */
public class StepMidnightReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        final Context app = context.getApplicationContext() != null
                ? context.getApplicationContext()
                : context;
        final PendingResult pending = goAsync();
        try {
            StepCounter.start(app); // 顺带注册监听，让 counter 尽快有值
        } catch (Throwable t) {
            // 忽略
        }
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    Thread.sleep(800L);
                } catch (InterruptedException e) {
                    // 忽略
                }
                try {
                    StepCounter.rolloverNow(app);
                } catch (Throwable t) {
                    // 忽略
                }
                try {
                    StepScheduler.scheduleMidnight(app);
                } catch (Throwable t) {
                    // 忽略
                }
                try {
                    pending.finish();
                } catch (Throwable t) {
                    // 忽略
                }
            }
        }).start();
    }
}

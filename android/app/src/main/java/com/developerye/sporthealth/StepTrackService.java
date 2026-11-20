package com.developerye.sporthealth;

import android.app.Service;
import android.content.Intent;
import android.os.IBinder;

/**
 * 计步常驻服务（普通 Service，**不带**常驻通知）。
 *
 * 它做什么：
 *   把 StepCounter 的传感器监听挂住，进程活着期间持续累积，并定期落盘；
 *   同时保证每日零点闹钟被排上。
 *
 * 它不做什么：
 *   不显示通知（前台通知会一直占着状态栏，体验差）；
 *   不参与定位（那是 MotionKeepAliveService 的活）。
 *
 * 被系统回收也没关系：
 *   START_STICKY 会尽量重拉；即使不重拉，counter 是「开机累计」，下次注册就能拿回真值，
 *   检测器计数也会从 SharedPreferences 续上，不会归零。
 */
public class StepTrackService extends Service {

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        try {
            StepCounter.start(this);
        } catch (Throwable t) {
            // 忽略
        }
        try {
            StepScheduler.scheduleMidnight(this);
        } catch (Throwable t) {
            // 忽略
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        // 不注销传感器监听：进程被回收时监听自然消失，重拉后重新注册即可
    }
}

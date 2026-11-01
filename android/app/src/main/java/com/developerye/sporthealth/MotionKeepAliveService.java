package com.developerye.sporthealth;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

/**
 * 运动保活前台服务。
 *
 * 为什么需要它：
 *   Android 8+ 之后，普通后台进程的定位会被 Doze / App Standby 降频甚至掐断。
 *   只声明 ACCESS_BACKGROUND_LOCATION 并不能保证锁屏后还在采点——
 *   系统允许"有前台服务的应用"持续使用定位，所以必须挂一个前台服务 + 常驻通知。
 *
 * 它做什么：
 *   只做一件事——把本进程提升为前台优先级，让 uni 的 plus.geolocation 监听
 *   在锁屏/切后台时继续收到位置回调。它自己不去定位，避免和 JS 侧重复采集。
 *
 * 它不做什么：
 *   不做轨迹过滤、不写数据库，那些仍然在 JS 侧（src/utils/track.js）。
 *   服务被杀后由 START_STICKY 让系统尝试重建。
 */
public class MotionKeepAliveService extends Service {

    private static final String CHANNEL_ID = "motion_keepalive";
    private static final String CHANNEL_NAME = "运动记录";
    private static final int NOTIFY_ID = 20261101;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // 必须在上层"应用在后台"的情况下也要能起来，所以这里一律 startForeground
        startForeground(NOTIFY_ID, buildNotification());
        // 被系统杀掉后尽量重建（不能保证，但比不声明好）
        return START_STICKY;
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm == null) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("运动轨迹记录进行中时显示");
        channel.setShowBadge(false);
        channel.enableVibration(false);
        channel.enableLights(false);
        nm.createNotificationChannel(channel);
    }

    private Notification buildNotification() {
        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            builder = new Notification.Builder(this, CHANNEL_ID);
        } else {
            builder = new Notification.Builder(this);
        }

        // 点通知回到 App（如果有启动 Activity）
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (launch != null) {
            launch.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
            PendingIntent pi = PendingIntent.getActivity(
                    this, 0, launch, pendingIntentFlags());
            builder.setContentIntent(pi);
        }

        builder.setContentTitle("正在记录运动")
                .setContentText("锁屏或切到其他应用也会继续记录轨迹")
                .setSmallIcon(android.R.drawable.ic_menu_mylocation)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            builder.setCategory(Notification.CATEGORY_SERVICE)
                    .setVisibility(Notification.VISIBILITY_PUBLIC);
        }
        return builder.build();
    }

    /** PendingIntent 的 flag 在 API 31 之后要求显式 IMMUTABLE */
    private int pendingIntentFlags() {
        if (Build.VERSION.SDK_INT >= 23) {
            return PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.FLAG_UPDATE_CURRENT;
    }
}

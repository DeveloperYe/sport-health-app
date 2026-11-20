package com.developerye.sporthealth;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * 开机接收器：闹钟在重启后会被系统清空，这里负责重新排上，并试着把计步服务拉起来。
 *
 * 注意：从 BOOT_COMPLETED 起普通 Service 在新系统上可能被拒（后台启动限制），
 * 所以这里只做"尽力而为"，失败了也不影响功能 —— 真正保证零点精度的是闹钟本身，
 * 而用户下次打开 App 时 StepCounter.start() 会自动接上（counter 是开机累计，不会丢）。
 */
public class StepBootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent != null ? intent.getAction() : null;
        if (action == null || !Intent.ACTION_BOOT_COMPLETED.equals(action)) return;
        try {
            StepScheduler.scheduleMidnight(context);
        } catch (Throwable t) {
            // 忽略
        }
        try {
            context.startService(new Intent(context, StepTrackService.class));
        } catch (Throwable t) {
            // 后台启动可能被系统拒绝，忽略
        }
    }
}

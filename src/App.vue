<script>
import { autoSyncSteps } from '@/utils/cloud.js'

export default {
  onLaunch: function () {},
  onShow: function () {
    // 启动/回到前台时自动同步今日步数（Android 原生计步器 / 微信运动）
    autoSyncSteps()
  },
  onHide: function () {},
}
</script>

<style>
/* 全局公共样式（Keep 暗色风） */
page {
  background-color: #101014;
  color: #f2f3f5;
  font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', 'PingFang SC',
    'Microsoft YaHei', sans-serif;
}

view,
text,
button {
  box-sizing: border-box;
}

button::after {
  border: none;
}
</style>

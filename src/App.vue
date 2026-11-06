<script>
import { autoSyncSteps } from '@/utils/cloud.js'
import { initTheme, applyTheme, getMode } from '@/utils/theme.js'

export default {
  onLaunch: function () {
    // 主题要在首帧就定下来，否则会先闪一下默认暗色
    initTheme()
  },
  onShow: function () {
    // 回到前台时如果设的是「跟随系统」，重算一次（用户可能在后台改了系统深色模式）
    if (getMode() === 'auto') applyTheme('auto')
    // 启动/回到前台时自动同步今日步数（Android 原生计步器 / 微信运动）
    autoSyncSteps()
  },
  onHide: function () {},
}
</script>

<style lang="scss">
@import './styles/theme.scss';

/* 全局基础样式：所有颜色都来自 CSS 变量，随主题切换 */
page {
  /* 用透明而不是具体颜色：page 是 .t-dark/.t-light 的父节点，拿不到主题变量，
     写死任何一种颜色都会在另一种主题下露出色差。
     真正的底色由 .page（铺满整屏）+ 原生窗口底色（uni.setBackgroundColor）保证。 */
  background-color: transparent;
  color: var(--text-1);
  font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', 'PingFang SC',
    'Microsoft YaHei', sans-serif;
  transition: background-color 0.26s var(--ease), color 0.26s var(--ease);
}

view,
text,
button {
  box-sizing: border-box;
}

button::after {
  border: none;
}

/* ===== H5 端：导航栏与 tabBar 跟随主题（App 端由原生 API 负责） ===== */
// #ifdef H5
body[data-theme='dark'] .uni-page-head {
  background-color: #0b0d10 !important;
  box-shadow: inset 0 -1px 0 #262c35 !important;
}
body[data-theme='dark'] .uni-page-head__title,
body[data-theme='dark'] .uni-page-head-btn {
  color: #f3f5f7 !important;
}
body[data-theme='dark'] .uni-tabbar {
  background-color: #0f1216 !important;
  box-shadow: inset 0 1px 0 #262c35 !important;
}
body[data-theme='light'] .uni-page-head {
  background-color: #f4f6f8 !important;
  box-shadow: inset 0 -1px 0 #e3e9f0 !important;
}
body[data-theme='light'] .uni-page-head__title,
body[data-theme='light'] .uni-page-head-btn {
  color: #11161c !important;
}
body[data-theme='light'] .uni-tabbar {
  background-color: #ffffff !important;
  box-shadow: inset 0 1px 0 #e3e9f0 !important;
}
body[data-theme='light'] .uni-tabbar__label {
  color: #8b96a5 !important;
}
// #endif

/* 页面根壳：所有页面共用，保证整屏铺满 + 主题平滑过渡 */
.page {
  min-height: 100vh;
  background-color: var(--bg-page);
  color: var(--text-1);
  /* 数字等宽：步数/心率/配速跳动时不抖，运动感的关键细节 */
  font-variant-numeric: tabular-nums;
  transition: background-color 0.26s var(--ease), color 0.26s var(--ease);
}

/* ===== 平面按钮基线（各页面在此基础上微调，不再堆阴影/渐变） ===== */
.btn-flat {
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 999rpx;
  background-color: var(--accent);
  color: var(--on-accent);
  font-weight: 700;
  letter-spacing: 0.5rpx;
  border: none;
  transition: transform 0.12s var(--ease), background-color 0.18s var(--ease),
    opacity 0.18s var(--ease);
}
.btn-flat:active {
  transform: scale(0.97);
  opacity: 0.92;
}

.btn-outline {
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 999rpx;
  background-color: transparent;
  color: var(--text-2);
  border: 1rpx solid var(--line-strong);
  transition: transform 0.12s var(--ease), color 0.18s var(--ease),
    border-color 0.18s var(--ease);
}
.btn-outline:active {
  transform: scale(0.97);
  color: var(--text-1);
  border-color: var(--text-3);
}
</style>

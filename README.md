# Minshan Serenity

This template should help get you started developing with Vue 3 in Vite.

## 功能

### 三维卡通地形地图（路由 `/terrain`）

程序化生成的低多边形卡通地形，支持单击落点、标记管理与贴地路线。

- 噪声高度场（fBm + 山脊噪声 + 岛屿衰减 + 梯田化），同一个 `seed` 必然生成同一张地图
- 块面感来自「非索引几何 + 逐面单色单法线 + 卡通阶梯渐变」，不依赖任何贴图资源
- 落点拾取在高度场上做光线步进 + 二分收敛（精度约 0.01），指针移动不 raycast 网格
- 路线是贴地飘带（沿弧长铺虚线并流动），横向过坎不会被地形切掉
- 源码在 `src/three/`：`noise` → `heightField` → `terrainMesh` / `scenery` / `route` / `picking` → `cartoonTerrain`
- 页面在 `src/views/TerrainMapView.vue`，复用了 `src/composables/useThreeStage.js`

## 自检脚本

三维画面是否正确只能靠眼睛，但「代码是否合法、场景能否构建」不该靠眼睛。
下面三个脚本不需要浏览器、也不需要打包器：

| 命令 | 验证内容 |
| --- | --- |
| `npm run check:terrain` | 噪声确定性、高度场值域、三角剖分无缝、拾取精度、飘带贴地等 60+ 项 |
| `npm run check:world` | 用假 DOM 真实构建场景图并派发交互事件，50+ 项；含初始取景的 NDC 实测 |
| `npm run check:view` | 用 `@vue/compiler-sfc` 编译所有 `.vue`，并解析三维模块导入图 |
| `npm run check` | 依次执行以上三个 |

## Recommended IDE Setup

[VS Code](https://code.visualstudio.com/) + [Vue (Official)](https://marketplace.visualstudio.com/items?itemName=Vue.volar) (and disable Vetur).

## Recommended Browser Setup

- Chromium-based browsers (Chrome, Edge, Brave, etc.):
  - [Vue.js devtools](https://chromewebstore.google.com/detail/vuejs-devtools/nhdogjmejiglipccpnnnanhbledajbpd)
  - [Turn on Custom Object Formatter in Chrome DevTools](http://bit.ly/object-formatters)
- Firefox:
  - [Vue.js devtools](https://addons.mozilla.org/en-US/firefox/addon/vue-js-devtools/)
  - [Turn on Custom Object Formatter in Firefox DevTools](https://fxdx.dev/firefox-devtools-custom-object-formatters/)

## Customize configuration

See [Vite Configuration Reference](https://vite.dev/config/).

## Project Setup

```sh
npm install
```

### Compile and Hot-Reload for Development

```sh
npm run dev
```

### Compile and Minify for Production

```sh
npm run build
```

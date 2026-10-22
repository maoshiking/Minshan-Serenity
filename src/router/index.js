import { createRouter, createWebHistory } from 'vue-router'

/**
 * 路由表。
 * meta.title 供 afterEach 写入 document.title；meta.public 预留给后续登录态拦截。
 */
const routes = [
  {
    path: '/',
    name: 'home',
    component: () => import('@/views/HomeView.vue'),
    meta: { title: '首页', public: true },
  },
  {
    path: '/lab',
    name: 'lab',
    component: () => import('@/views/StackLabView.vue'),
    meta: { title: '技术栈自检', public: true },
  },
  {
    path: '/terrain',
    name: 'terrain',
    component: () => import('@/views/TerrainMapView.vue'),
    meta: { title: '水磨古镇地形', public: true },
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('@/views/NotFoundView.vue'),
    meta: { title: '页面不存在', public: true },
  },
]

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
  scrollBehavior(to, from, savedPosition) {
    return savedPosition ?? { top: 0 }
  },
})

router.afterEach((to) => {
  const base = 'Minshan Serenity'
  document.title = to.meta?.title ? `${to.meta.title} · ${base}` : base
})

export default router

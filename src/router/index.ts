import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import type { Permission } from '@shared/index';
import { useAuthStore } from '@/stores/auth';
import { useWorkspaceStore } from '@/stores/workspace';

declare module 'vue-router' {
  interface RouteMeta {
    public?: boolean;
    title?: string;
    permission?: Permission;
    /** Hide the bottom navigation (full-screen flows like the composer). */
    immersive?: boolean;
  }
}

// Every route is lazy-loaded.
const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/dashboard' },
  { path: '/login', name: 'login', component: () => import('@/features/auth/LoginView.vue'), meta: { public: true, title: 'Sign in' } },
  { path: '/onboarding', name: 'onboarding', component: () => import('@/features/auth/OnboardingView.vue'), meta: { title: 'Welcome' } },
  { path: '/dashboard', name: 'dashboard', component: () => import('@/features/dashboard/DashboardView.vue'), meta: { title: 'Today' } },
  { path: '/calendar', name: 'calendar', component: () => import('@/features/calendar/CalendarView.vue'), meta: { title: 'Calendar' } },
  { path: '/posts', name: 'posts', component: () => import('@/features/posts/PostsView.vue'), meta: { title: 'Posts' } },
  { path: '/posts/:postId', name: 'post', component: () => import('@/features/posts/PostDetailView.vue'), props: true, meta: { title: 'Post' } },
  { path: '/compose', name: 'compose', component: () => import('@/features/composer/ComposerView.vue'), meta: { title: 'Create', permission: 'content.write', immersive: true } },
  { path: '/compose/:postId', name: 'compose-edit', component: () => import('@/features/composer/ComposerView.vue'), props: true, meta: { title: 'Edit', permission: 'content.write', immersive: true } },
  { path: '/bulk', name: 'bulk', component: () => import('@/features/bulk/BulkView.vue'), meta: { title: 'Bulk planner', permission: 'content.schedule' } },
  { path: '/import', name: 'import', component: () => import('@/features/imports/ImportView.vue'), meta: { title: 'Import & crosspost', permission: 'content.write' } },
  { path: '/media', name: 'media', component: () => import('@/features/media/MediaView.vue'), meta: { title: 'Media' } },
  { path: '/connections', name: 'connections', component: () => import('@/features/connections/ConnectionsView.vue'), meta: { title: 'Connections' } },
  { path: '/connections/:connectionId', name: 'connection', component: () => import('@/features/connections/ConnectionDetailView.vue'), props: true, meta: { title: 'Connection' } },
  { path: '/logs', name: 'logs', component: () => import('@/features/logs/LogsView.vue'), meta: { title: 'Activity log' } },
  { path: '/notifications', name: 'notifications', component: () => import('@/features/notifications/NotificationsView.vue'), meta: { title: 'Notifications' } },
  { path: '/settings', name: 'settings', component: () => import('@/features/settings/SettingsView.vue'), meta: { title: 'Settings' } },
  { path: '/settings/team', name: 'team', component: () => import('@/features/settings/TeamView.vue'), meta: { title: 'Team' } },
  { path: '/more', name: 'more', component: () => import('@/features/more/MoreView.vue'), meta: { title: 'More' } },
  { path: '/:pathMatch(.*)*', name: 'not-found', component: () => import('@/features/more/NotFoundView.vue'), meta: { title: 'Not found', public: true } },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior(_to, _from, saved) {
    return saved ?? { top: 0 };
  },
});

router.beforeEach(async (to) => {
  const auth = useAuthStore();
  if (!auth.ready) await auth.readyPromise;
  if (to.meta.public) {
    if (to.name === 'login' && auth.isSignedIn) return { path: (to.query.redirect as string) || '/dashboard' };
    return true;
  }
  if (!auth.isSignedIn) return { name: 'login', query: { redirect: to.fullPath } };
  if (auth.memberships.length === 0 && to.name !== 'onboarding') return { name: 'onboarding' };
  if (to.meta.permission) {
    const ws = useWorkspaceStore();
    if (ws.role && !ws.can(to.meta.permission)) return { name: 'dashboard', query: { denied: '1' } };
  }
  return true;
});

router.afterEach((to) => {
  document.title = to.meta.title ? `${to.meta.title} · CrepeLite Social` : 'CrepeLite Social Hub';
});

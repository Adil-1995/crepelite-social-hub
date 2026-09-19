import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from '@/App.vue';
import { router } from '@/router';
import { installPrimeVue } from '@/theme/primevue';
import { useUiStore } from '@/stores/ui';
import '@/styles/main.css';

const app = createApp(App);

app.use(createPinia());
// PrimeVue must be installed before the router so views resolving PrimeVue
// components (and `useToast`/`useConfirm`) always find the plugin.
installPrimeVue(app);
app.use(router);

useUiStore().initTheme();

app.mount('#app');

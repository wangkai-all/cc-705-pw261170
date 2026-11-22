import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import CollectView from './views/CollectView.vue';
import DemoView from './views/DemoView.vue';
import HistoryView from './views/HistoryView.vue';
import './styles.css';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'collect', component: CollectView },
    { path: '/demo', name: 'demo', component: DemoView },
    { path: '/history', name: 'history', component: HistoryView },
    { path: '/history/:id', name: 'run', component: HistoryView, props: true },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

createApp(App).use(router).mount('#app');

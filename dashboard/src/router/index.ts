import { createRouter, createWebHashHistory } from 'vue-router'
// We use dynamic imports for views
const ReactiveView = () => import('../views/ReactiveView.vue')
const CronView = () => import('../views/CronView.vue')

const router = createRouter({
    history: createWebHashHistory(), // Hash mode is better for relative file serving
    routes: [
        {
            path: '/',
            redirect: '/reactive'
        },
        {
            path: '/reactive',
            name: 'reactive',
            component: ReactiveView
        },
        {
            path: '/cron',
            name: 'cron',
            component: CronView
        }
    ]
})

export default router

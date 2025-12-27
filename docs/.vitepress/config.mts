import { defineConfig } from 'vitepress'

export default defineConfig({
    base: '/mongodash/',
    title: "Mongodash",
    description: "A modern JavaScript & Typescript MongoDB-based utility library",
    cleanUrls: true,
    themeConfig: {
        logo: '/logo-backgroundless.png',
        siteTitle: false,
        nav: [
            { text: 'Home', link: '/' },
            { text: 'Getting Started', link: '/getting-started' },
            { text: 'GitHub', link: 'https://github.com/VaclavObornik/mongodash' }
        ],

        sidebar: [
            {
                text: 'Introduction',
                items: [
                    { text: 'Getting Started', link: '/getting-started' },
                    { text: 'Initialization', link: '/initialization' }
                ]
            },
            {
                text: 'Core Features',
                items: [
                    {
                        text: 'Reactive Tasks',
                        collapsed: false,
                        items: [
                            { text: 'Overview', link: '/reactive-tasks/' },
                            { text: 'Getting Started', link: '/reactive-tasks/getting-started' },
                            { text: 'Examples', link: '/reactive-tasks/examples' },
                            { text: 'Guides', link: '/reactive-tasks/guides' },
                            { text: 'Configuration', link: '/reactive-tasks/configuration' },
                            { text: 'Retry Policy', link: '/reactive-tasks/policy-retry' },
                            { text: 'Cleanup Policy', link: '/reactive-tasks/policy-cleanup' },
                            { text: 'Filter & Logic Evolution', link: '/reactive-tasks/evolution' },
                            { text: 'Reconciliation', link: '/reactive-tasks/reconciliation' },
                            { text: 'Task Management & DLQ', link: '/reactive-tasks/management' },
                            { text: 'Monitoring', link: '/reactive-tasks/monitoring' },
                            { text: 'Core Concepts', link: '/reactive-tasks/core-concepts' },
                        ]
                    },
                    { text: 'Cron Tasks', link: '/cron-tasks' },
                    { text: 'Dashboard', link: '/dashboard' },
                    { text: 'Concurrency Control', link: '/with-lock' },
                    { text: 'Transactions', link: '/with-transaction' },
                ]
            },
            {
                text: 'Utilities',
                items: [
                    { text: 'Process In Batches', link: '/process-in-batches' },
                    { text: 'Getters', link: '/getters' }
                ]
            }
        ],

        socialLinks: [
            { icon: 'github', link: 'https://github.com/VaclavObornik/mongodash' }
        ],

        outline: [2, 3]
    }
})

import { defineConfig } from 'vitepress'

export default defineConfig({
    title: "Mongodash",
    description: "A modern JavaScript & Typescript MongoDB-based utility library",
    cleanUrls: true,
    themeConfig: {
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
                    { text: 'Reactive Tasks', link: '/reactive-tasks' },
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

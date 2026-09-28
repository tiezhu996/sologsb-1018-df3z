import './app.postcss'
import App from './App.svelte'

const app = new App({
  target: document.getElementById('app')!
})

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => undefined))
}

export default app

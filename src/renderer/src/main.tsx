import './assets/main.css'
import 'highlight.js/styles/atom-one-dark.css'

import { createRoot } from 'react-dom/client'
import App from './App'

// StrictMode disabled: it double-mounts effects, which would register two
// copies of the tab-event listener and double-process every IPC event.
createRoot(document.getElementById('root')!).render(<App />)

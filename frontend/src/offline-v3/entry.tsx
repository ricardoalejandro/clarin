import { createRoot } from 'react-dom/client'
import OfflineRuntimeApp from './OfflineRuntimeApp'
import './offline-runtime.css'

const root = document.getElementById('clarin-offline-root')
if (!root) throw new Error('No se encontró la raíz pública de Clarin offline.')
createRoot(root).render(<OfflineRuntimeApp />)

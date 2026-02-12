'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { MessageSquare, Lock, User } from 'lucide-react'

export default function LoginPage() {
  const router = useRouter()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
        credentials: 'include',
      })

      const data = await res.json()

      if (!data.success) {
        setError(data.error || 'Error al iniciar sesión')
        return
      }

      // Store token
      localStorage.setItem('token', data.token)
      router.push('/dashboard')
      router.refresh()
    } catch {
      setError('Error de conexión')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="h-screen bg-gradient-to-br from-green-500 via-green-600 to-teal-700 flex items-center justify-center p-4 overflow-auto">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-20 h-20 bg-white rounded-full shadow-lg mb-4">
            <MessageSquare className="w-10 h-10 text-green-600" />
          </div>
          <h1 className="text-3xl font-bold text-white">Clarin</h1>
          <p className="text-green-100 mt-2">WhatsApp Business CRM</p>
        </div>

        {/* Login Form */}
        <form onSubmit={handleSubmit} className="bg-white rounded-2xl shadow-2xl p-8">
          <h2 className="text-2xl font-semibold text-gray-800 mb-6 text-center">
            Iniciar Sesión
          </h2>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-600 px-4 py-3 rounded-lg mb-4 text-sm">
              {error}
            </div>
          )}

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Usuario
              </label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Ingresa tu usuario"
                  className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent text-gray-900 placeholder:text-gray-400"
                  required
                  disabled={loading}
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Contraseña
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Ingresa tu contraseña"
                  className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-transparent text-gray-900 placeholder:text-gray-400"
                  required
                  disabled={loading}
                />
              </div>
            </div>
          </div>

          <button
            type="submit"
            className="w-full mt-6 bg-green-600 hover:bg-green-700 text-white py-3 rounded-lg font-medium transition-colors disabled:opacity-50"
            disabled={loading}
          >
            {loading ? 'Ingresando...' : 'Iniciar Sesión'}
          </button>
        </form>

        <p className="text-center text-green-100 mt-6 text-sm">
          © 2026 Clarin CRM. Todos los derechos reservados.
        </p>
      </div>
    </div>
  )
}

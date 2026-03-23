import re

with open('/root/proyect/clarin/frontend/src/app/dashboard/dynamics/[id]/page.tsx', 'r') as f:
    content = f.read()

modal_html = """      )}

      {/* QR Code Modal */}
      {showQR && dynamic && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl w-full max-w-sm overflow-hidden shadow-2xl animate-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between p-4 border-b border-slate-100">
              <h3 className="font-semibold text-slate-800">Código QR</h3>
              <button onClick={() => setShowQR(false)} className="p-1 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100 transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-8 flex flex-col items-center justify-center space-y-6">
              <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100">
                <QRCodeSVG
                  value={`${window.location.origin}/d/${dynamic.slug}`}
                  size={200}
                  level="H"
                  includeMargin={false}
                />
              </div>
              <p className="text-sm text-center text-slate-500">
                Escanea este código para acceder a la dinámica directamente desde un dispositivo móvil.
              </p>
              <div className="w-full flex gap-2">
                <div className="flex-1 bg-slate-50 rounded-lg px-3 py-2 text-sm text-slate-600 truncate border border-slate-200">
                  {`${window.location.origin}/d/${dynamic.slug}`}
                </div>
                <button
                  onClick={copyLink}
                  className="px-3 py-2 bg-emerald-100 text-emerald-700 rounded-lg hover:bg-emerald-200 transition-colors flex shrink-0 items-center justify-center"
                  title="Copiar enlace"
                >
                  {copiedLink ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}"""

content = content.replace("      )}\n    </div>\n  );\n}", modal_html)

with open('/root/proyect/clarin/frontend/src/app/dashboard/dynamics/[id]/page.tsx', 'w') as f:
    f.write(content)

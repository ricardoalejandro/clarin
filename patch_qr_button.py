import re

with open('/root/proyect/clarin/frontend/src/app/dashboard/dynamics/[id]/page.tsx', 'r') as f:
    content = f.read()

qr_button = """          <button
            onClick={() => setShowQR(true)}
            className="flex items-center gap-1.5 px-3 py-2 text-sm border border-slate-200 rounded-lg hover:bg-slate-50 text-slate-600 transition-colors"
          >
            <QrCode className="w-4 h-4" />
            Código QR
          </button>
          <button
            onClick={copyLink}"""

content = content.replace("          <button\n            onClick={copyLink}", qr_button)

with open('/root/proyect/clarin/frontend/src/app/dashboard/dynamics/[id]/page.tsx', 'w') as f:
    f.write(content)

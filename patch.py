import re

with open('/root/proyect/clarin/frontend/src/app/dashboard/dynamics/[id]/page.tsx', 'r') as f:
    content = f.read()

# Replace add form input
add_input_old = """<input
                  type="text"
                  value={newImageURL}
                  onChange={e => setNewImageURL(e.target.value)}
                  placeholder="URL de imagen (opcional)"
                  className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
                />"""
with open('patch_input_add.txt', 'r') as f:
    add_input_new = f.read().strip()

content = content.replace(add_input_old, add_input_new)

# Replace edit form input
edit_input_old = """<input
                          type="text"
                          value={editItemImageURL}
                          onChange={e => setEditItemImageURL(e.target.value)}
                          placeholder="URL imagen"
                          className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
                        />"""
with open('patch_input_edit.txt', 'r') as f:
    edit_input_new = f.read().strip()

content = content.replace(edit_input_old, edit_input_new)

with open('/root/proyect/clarin/frontend/src/app/dashboard/dynamics/[id]/page.tsx', 'w') as f:
    f.write(content)


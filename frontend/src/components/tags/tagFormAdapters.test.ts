import { describe, expect, it } from 'vitest'
import { automationTagId, automationTagPatch, importTagName, tagSelectionIds } from './tagFormAdapters'
import { tagPickerSearchPath, type TagCatalogContext } from './tagPickerSearch'
const tag = { id: 'one', name: 'Prioridad', color: '#2563EB' }
describe('tag form contracts', () => {
  it.each(['contact_create','lead_create','lead_import','automation'] as TagCatalogContext[])('scopes %s searches and bounds the result set', catalogContext => {
    const url = tagPickerSearchPath({ catalogContext }, 'A B')
    expect(url).toContain('context_type=' + catalogContext)
    expect(url).toContain('q=A+B&limit=20')
  })
  it('uses profile context for existing Contact associations', () => {
    expect(tagPickerSearchPath({ contactId:'c1', context:{type:'lead',id:'l1'} },'vip')).toBe('/api/contact-profiles/c1/tags?context_type=lead&context_id=l1&q=vip&limit=20')
  })
  it('deduplicates hydration IDs and caps them at 25', () => {
    const url = tagPickerSearchPath({ catalogContext:'automation' },'',Array.from({length:30},(_,i)=>String(i)))
    expect(new URL(url,'http://local').searchParams.get('ids')!.split(',')).toHaveLength(25)
  })
  it('keeps ID payloads authoritative including empty and preserves import catalog name', () => {
    expect(tagSelectionIds([tag,tag,{...tag,id:'two'}])).toEqual(['one','two'])
    expect(tagSelectionIds([])).toEqual([])
    expect(importTagName([tag])).toBe('Prioridad')
    expect(importTagName([])).toBe('')
  })
  it('hydrates legacy automation IDs, preserves unrelated config and clears both formats', () => {
    expect(automationTagId({config:{tag_id:'legacy'}})).toBe('legacy')
    expect(automationTagId({tag_id:'',config:{tag_id:'legacy'}})).toBe('')
    const patch=automationTagPatch({label:'Acción',config:{other:1,tag_id:'legacy'}},'new')
    expect(patch).toEqual({label:'Acción',tag_id:'new',config:{other:1,tag_id:'new'}})
    expect(automationTagPatch(patch,'')).toMatchObject({tag_id:'',config:{tag_id:''}})
  })
})

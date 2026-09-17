'use strict'

const { contextBridge, ipcRenderer } = require('electron')

if (window.location.protocol === 'clarin-offline:') {
  contextBridge.exposeInMainWorld('clarinOffline', Object.freeze({
    listAccounts: () => ipcRenderer.invoke('offline:list-accounts'),
    getState: accountID => ipcRenderer.invoke('offline:get-state', accountID),
    enqueue: (accountID, operation) => ipcRenderer.invoke('offline:enqueue', accountID, operation),
    sync: accountID => ipcRenderer.invoke('offline:sync', accountID),
		onAutoSyncCompleted: callback => {
			if (typeof callback !== 'function') return () => {}
			const listener = () => callback()
			ipcRenderer.on('offline:auto-sync-completed', listener)
			return () => ipcRenderer.removeListener('offline:auto-sync-completed', listener)
		},
    openOnline: () => ipcRenderer.invoke('offline:open-online')
  }))
} else if (window.location.protocol === 'https:') {
  contextBridge.exposeInMainWorld('clarinDesktop', Object.freeze({
    bootstrapStatus: () => ipcRenderer.invoke('desktop:bootstrap-status'),
    prepareEnrollment: () => ipcRenderer.invoke('desktop:prepare-enrollment'),
    completeEnrollment: approval => ipcRenderer.invoke('desktop:complete-enrollment', approval)
  }))
}

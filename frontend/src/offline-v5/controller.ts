import { OfflineV5Engine, sendableOfflineV5Operations } from './engine'
import { OfflineV5OnlineClient, OfflineV5APIError, batchOfflineV5Operations } from './onlineClient'
import { OfflineV5RouteAdapter } from './routeAdapter'
import { OfflineV5Error, type OfflineV5Root, type OfflineV5SessionSnapshot } from './types'

export class OfflineV5Controller {
  readonly routes: OfflineV5RouteAdapter

  constructor(readonly engine: OfflineV5Engine, readonly online = new OfflineV5OnlineClient(engine.origin)) {
    this.routes = new OfflineV5RouteAdapter(engine)
  }

  profile() { return this.engine.profile() }
  listLocalGrants() { return this.engine.listLocalGrants() }
  hasAnyPreparedCopy() { return this.engine.hasAnyPreparedCopy() }
  hasPreparedCopyForUsername(username: string) { return this.engine.hasPreparedCopyForUsername(username) }
  purgeLocalGrant(grantID: string) { return this.engine.purgeLocalGrant(grantID) }
  async refreshPreparedCopyAvailability() {
    const profile = await this.engine.browserProfile()
    const local = await this.engine.listLocalGrants()
    if (!local.length) return false
    const active: string[] = []
    try {
      for (let start = 0; start < local.length; start += 200) {
        active.push(...await this.online.activeLocalGrants(profile, local.slice(start, start + 200).map(item => item.grantId)))
      }
    } catch (error) {
      // A real outage must preserve a still-valid signed copy. A trusted
      // server rejection is fail-closed and is not treated as disconnection.
      if (error instanceof OfflineV5APIError && error.infrastructure) return this.engine.hasAnyPreparedCopy()
      throw error
    }
    await this.engine.reconcileLocalGrantStatus(active)
    return this.engine.hasAnyPreparedCopy()
  }
  reconcileLocalGrants(userID: string, authorizedGrantIDs: string[]) { return this.engine.reconcileLocalGrants(userID, authorizedGrantIDs) }
  hasPreparedCopy(userID: string, accountID: string) { return this.engine.hasPreparedCopy(userID, accountID) }

  async enroll(displayName: string) {
    const profile = await this.engine.browserProfile()
    const request = (await this.online.enroll(profile, displayName)).request
    await this.engine.rememberEnrollmentRequest(request.id)
    return request
  }

  async grants() {
    const profile = await this.engine.browserProfile()
    return this.online.grants(profile)
  }

  selection(grantID: string) { return this.online.selection(grantID) }

  replaceSelection(grantID: string, revision: number, items: Array<Pick<OfflineV5Root, 'module' | 'resource_type' | 'resource_id'>>) {
    return this.online.replaceSelection(grantID, revision, items)
  }

  async prepare(portID: string, grantID: string, password: string, persistent: boolean): Promise<OfflineV5SessionSnapshot> {
    const profile = await this.engine.browserProfile()
    const grants = await this.online.grants(profile)
    const grant = grants.items.find(item => item.grant_id === grantID && item.browser_profile_id === profile.browser_id)
    if (!grant || grant.state === 'revoked') throw new OfflineV5Error('grant_not_available', 'La autorización ya no está disponible para este navegador.')
    await this.engine.assertCanPrepareGrant(grantID)
    // Persist the signer encrypted before the server sees its public half. A
    // lost response, failed snapshot or browser restart can then resume with
    // the exact same key instead of stranding the grant in a 409 loop.
    const staged = await this.engine.stagePreparation(grant, password, persistent)
    let privateKey = staged.privateJWK
    try {
      privateKey = await this.online.registerKeys(profile, grant, grant.username, password, privateKey)
    } catch (error) {
      if (staged.created && error instanceof OfflineV5APIError && error.code === 'offline_reauthentication_failed') {
        await this.engine.discardPreparingGrant(grantID)
      }
      throw error
    }
    const bundle = await this.online.prepare(profile, grant, privateKey)
    const assets = await this.online.downloadPreparedAssets(bundle)
    return this.engine.installPreparedBundle({ portID, password, bundle, grantPrivateJWK: privateKey, persistent, assets })
  }

  unlockUser(portID: string, username: string, password: string, expected?: { user_id?: string; account_id?: string }) {
    return this.engine.unlockUser(portID, username, password, expected)
  }

  selectAccount(portID: string, grantID: string) { return this.engine.selectAccount(portID, grantID) }
  lock(portID: string) { return this.engine.lock(portID) }

  async sync(portID: string, generation: number): Promise<OfflineV5SessionSnapshot> {
    const profile = await this.engine.browserProfile()
    this.engine.sessions.setSyncState(portID, generation, 'syncing')
    try {
      const exchange = async (operations: ReturnType<typeof sendableOfflineV5Operations>) => {
        const session = this.engine.sessions.require(portID, generation)
        const response = await this.online.sync(profile, session.metadata.grant_private_jwk, {
          grant_id: session.identity.grant_id,
          browser_profile_id: session.identity.browser_profile_id,
          manifest_id: session.manifest.id,
          manifest_revision: session.manifest.revision,
          selection_revision: session.manifest.selection_revision,
          want_snapshots: session.manifest.roots.map(root => root.selection_id),
          operations,
        })
        await this.engine.applyReceipts(portID, generation, response.receipts || [])
        // Operators may disable all new offline authority while still letting
        // a superseded delivery retrieve receipts for changes already applied.
        // Keep the existing lease/copy; never synthesize a renewal locally.
        if (response.renewal_available !== false) {
          const assets = await this.online.downloadPreparedAssets(response)
          await this.engine.refreshPreparedBundle(portID, generation, response, assets)
        }
      }

      let pending = await this.engine.outbox(portID, generation)
      let session = this.engine.sessions.require(portID, generation)
      let sendable = sendableOfflineV5Operations(session.manifest, pending)

      // No changes means an ordinary manifest/snapshot refresh. If any change
      // is deferred, perform exactly one zero-operation refresh in this user
      // sync attempt. Never poll or loop internally while permission is absent.
      if (!pending.length || sendable.length !== pending.length) {
        await exchange([])
        pending = await this.engine.outbox(portID, generation)
        session = this.engine.sessions.require(portID, generation)
        sendable = sendableOfflineV5Operations(session.manifest, pending)
      }

      if (!sendable.length) return await this.engine.runtimeSnapshot(portID)
      const base = {
        grant_id: session.identity.grant_id,
        browser_profile_id: session.identity.browser_profile_id,
        manifest_id: session.manifest.id,
        manifest_revision: session.manifest.revision,
        selection_revision: session.manifest.selection_revision,
        want_snapshots: session.manifest.roots.map(root => root.selection_id),
      }
      const groups = batchOfflineV5Operations(base, sendable).map(batch => batch.map(operation => operation.operation_id))
      for (const operationIDs of groups) {
        session = this.engine.sessions.require(portID, generation)
        const latest = await this.engine.outbox(portID, generation)
        const latestByID = new Map(latest.map(operation => [operation.operation_id, operation]))
        const ready = new Map(sendableOfflineV5Operations(session.manifest, latest).map(operation => [operation.operation_id, operation]))
        const groupIDs = new Set(operationIDs)
        const operations = operationIDs.flatMap(id => {
          const operation = ready.get(id)
          if (!operation || operation.depends_on_operation_id && latestByID.has(operation.depends_on_operation_id) && !groupIDs.has(operation.depends_on_operation_id)) return []
          return [operation]
        })
        if (!operations.length) break
        await exchange(operations)
      }
      return await this.engine.runtimeSnapshot(portID)
    } catch (error) {
      const infrastructure = error instanceof OfflineV5APIError && error.infrastructure
      this.engine.sessions.setSyncState(portID, generation, infrastructure ? 'unavailable' : 'conflict', error instanceof Error ? error.message : 'No se pudo sincronizar.')
      return this.engine.runtimeSnapshot(portID)
    }
  }
}

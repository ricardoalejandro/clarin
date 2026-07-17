---
name: clarin-storage-management
description: Use when working with Clarin MinIO/S3 media, storage_objects, media_assets, storage usage, orphan detection, account purges, storage cleanup UI, or storage cleanup APIs.
---

# Clarin Storage Management

## Storage Model

- Media lives in MinIO under the `clarin-media` bucket.
- Object keys are account-prefixed, normally `account_id/...`.
- `storage_objects` is inventory/audit data.
- `media_assets` tracks active media objects and metadata.
- Validate live usage against MinIO, not only database rows, when storage accuracy matters.

## Orphan Classes

- Deleted-account orphan: object prefix belongs to an account ID that no longer exists. This can be deleted only after a dry-run confirms the target prefix.
- Active-account orphan: object belongs to an existing account but has no known database reference. Treat as candidate only.
- Known references include messages, contact avatars, campaigns, campaign attachments, document thumbnails, dynamic media, quick replies, saved stickers, survey uploads, and active `media_assets`.
- WhatsApp own-status media and any derivative/edited status media are known references until their retention record expires and no other entity references the asset.

## Safety Rules

- Always run a dry-run or count before deleting storage.
- Never delete active-account candidates without explicit confirmation and an age rule.
- Never infer safety from filename alone; use account prefix plus reference scan.
- On replacement workflows, attach the new asset before scheduling the old one. Recheck references immediately before physical deletion because deduplication can make several entities share one asset.
- If an upload succeeds but the database attachment fails, register/schedule a durable orphan cleanup path; never leave cleanup dependent on an HTTP request remaining alive.
- Prefer MinIO/S3 APIs or clients over direct filesystem deletion.
- Do not print MinIO secrets, `.env`, signed URLs, cookies, JWTs, or raw object contents.

## Verification

- Recount total objects and bytes after cleanup.
- Confirm deleted-account orphan count is zero for targeted prefixes.
- Confirm active accounts still load storage pages.
- Report exactly how many objects and bytes were removed.

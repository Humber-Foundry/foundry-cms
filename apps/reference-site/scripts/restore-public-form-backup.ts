import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

import { referenceSiteDefinition } from "@foundry/site-definition";

import type { D1DatabaseBinding } from "../src/d1-human-access-store";
import { createD1RestDatabase } from "../src/d1-rest-database";
import type { R2BackupBucket } from "../src/encrypted-r2-form-backup-vault";
import { runPublicFormRecoveryOperator } from "../src/public-form-recovery-operator";

type Options = Readonly<{
  accountId: string;
  primaryDatabaseId: string;
  recoveryDatabaseId: string;
  bucket: string;
  backupId: string;
  privateKeyFile: string;
  actorMembershipId: string;
  confirmBackupId: string;
}>;

const usage = `Usage:
  npm run forms:restore --workspace @foundry/reference-site -- \\
    --account-id <cloudflare-account-id> \\
    --primary-database-id <primary-d1-id> \\
    --recovery-database-id <isolated-recovery-d1-id> \\
    --bucket <private-r2-bucket> \\
    --backup-id <backup-id> \\
    --private-key-file <pkcs8-private-key-file> \\
    --actor-membership-id <active-owner-membership-id> \\
    --confirm-backup-id <same-backup-id>`;

function parseOptions(arguments_: ReadonlyArray<string>): Options | null {
  if (arguments_.includes("--help")) {
    process.stdout.write(`${usage}\n`);
    return null;
  }
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (name === undefined || !name.startsWith("--") || value === undefined) {
      throw new Error("form_recovery_arguments_invalid");
    }
    if (values.has(name)) throw new Error("form_recovery_arguments_invalid");
    values.set(name, value);
  }
  const read = (name: string) => {
    const value = values.get(name);
    if (value === undefined || value.length === 0) {
      throw new Error("form_recovery_arguments_invalid");
    }
    return value;
  };
  const options = {
    accountId: read("--account-id"),
    primaryDatabaseId: read("--primary-database-id"),
    recoveryDatabaseId: read("--recovery-database-id"),
    bucket: read("--bucket"),
    backupId: read("--backup-id"),
    privateKeyFile: read("--private-key-file"),
    actorMembershipId: read("--actor-membership-id"),
    confirmBackupId: read("--confirm-backup-id"),
  };
  if (
    values.size !== 8 ||
    options.confirmBackupId !== options.backupId ||
    options.primaryDatabaseId === options.recoveryDatabaseId
  ) {
    throw new Error("form_recovery_arguments_invalid");
  }
  return options;
}

function privateKeyBase64(value: string) {
  const trimmed = value.trim();
  const encoded = trimmed.startsWith("-----BEGIN PRIVATE KEY-----")
    ? trimmed
        .replace("-----BEGIN PRIVATE KEY-----", "")
        .replace("-----END PRIVATE KEY-----", "")
        .replace(/\s/gu, "")
    : trimmed.replace(/\s/gu, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
    throw new Error("form_recovery_private_key_invalid");
  }
  return encoded;
}

async function runWrangler(
  arguments_: ReadonlyArray<string>,
  accountId: string,
) {
  const executable = resolve(
    import.meta.dirname,
    "../../../node_modules/.bin/wrangler",
  );
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(executable, arguments_, {
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error("form_recovery_backup_download_failed"));
    });
  });
}

function createRemoteBackupBucket({
  database,
  accountId,
  bucket,
  backupId,
  destination,
}: {
  database: D1DatabaseBinding;
  accountId: string;
  bucket: string;
  backupId: string;
  destination: string;
}): R2BackupBucket {
  return {
    async get(key) {
      const record = await database
        .prepare(
          `SELECT object_key, integrity_hash, created_at, expires_at
           FROM public_form_backup_records
           WHERE backup_id = ?1 AND object_key = ?2
           LIMIT 1`,
        )
        .bind(backupId, key)
        .first<{
          object_key: string;
          integrity_hash: string;
          created_at: string;
          expires_at: string;
        }>();
      if (record === null) return null;
      await runWrangler(
        [
          "r2",
          "object",
          "get",
          `${bucket}/${record.object_key}`,
          "--remote",
          "--file",
          destination,
        ],
        accountId,
      );
      const bytes = await readFile(destination);
      return {
        customMetadata: {
          siteId: referenceSiteDefinition.site.id,
          backupId,
          createdAt: record.created_at,
          expiresAt: record.expires_at,
          integrityHash: record.integrity_hash,
        },
        async arrayBuffer() {
          return bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ) as ArrayBuffer;
        },
      };
    },
    put: async () => {
      throw new Error("form_recovery_bucket_read_only");
    },
    list: async () => {
      throw new Error("form_recovery_bucket_read_only");
    },
    delete: async () => {
      throw new Error("form_recovery_bucket_read_only");
    },
  };
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options === null) return;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (apiToken === undefined || apiToken.length === 0) {
    throw new Error("form_recovery_cloudflare_token_required");
  }
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "foundry-form-recovery-"),
  );
  try {
    const primaryDatabase = createD1RestDatabase({
      accountId: options.accountId,
      databaseId: options.primaryDatabaseId,
      apiToken,
    });
    const recoveryDatabase = createD1RestDatabase({
      accountId: options.accountId,
      databaseId: options.recoveryDatabaseId,
      apiToken,
    });
    const evidence = await runPublicFormRecoveryOperator({
      primaryDatabase,
      recoveryDatabase,
      backupBucket: createRemoteBackupBucket({
        database: primaryDatabase,
        accountId: options.accountId,
        bucket: options.bucket,
        backupId: options.backupId,
        destination: join(temporaryDirectory, "backup.enc"),
      }),
      recoveryPrivateKeyBase64: privateKeyBase64(
        await readFile(options.privateKeyFile, "utf8"),
      ),
      backupId: options.backupId,
      actorMembershipId: options.actorMembershipId,
    });
    process.stdout.write(
      `${JSON.stringify({
        status: "verified_and_cleaned",
        backupId: options.backupId,
        submissions: evidence.submissions,
        auditFacts: evidence.auditFacts,
        integrityHash: evidence.integrityHash,
        verifiedAt: evidence.verifiedAt,
      })}\n`,
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error: unknown) {
  const code = error instanceof Error ? error.message : "form_recovery_failed";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}

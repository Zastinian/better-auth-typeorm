import "reflect-metadata";
import { betterAuth } from "better-auth";
import { Column, DataSource, Entity, PrimaryColumn, type QueryRunner } from "typeorm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { typeormAdapter } from "../package/src";

@Entity({ name: "user" })
class PerfUser {
  @PrimaryColumn("text")
  id!: string;

  @Column("text")
  name!: string;

  @Column("text", { unique: true })
  email!: string;

  @Column("boolean", { default: false })
  emailVerified!: boolean;

  @Column("text", { nullable: true })
  image!: string | null;

  @Column("timestamptz", { default: () => "CURRENT_TIMESTAMP" })
  createdAt!: Date;

  @Column("timestamptz", { default: () => "CURRENT_TIMESTAMP" })
  updatedAt!: Date;
}

@Entity({ name: "session" })
class PerfSession {
  @PrimaryColumn("text")
  id!: string;

  @Column("timestamptz")
  expiresAt!: Date;

  @Column("text", { unique: true })
  token!: string;

  @Column("timestamptz", { default: () => "CURRENT_TIMESTAMP" })
  createdAt!: Date;

  @Column("timestamptz", { default: () => "CURRENT_TIMESTAMP" })
  updatedAt!: Date;

  @Column("text", { nullable: true })
  ipAddress!: string | null;

  @Column("text", { nullable: true })
  userAgent!: string | null;

  @Column("text")
  userId!: string;
}

@Entity({ name: "account" })
class PerfAccount {
  @PrimaryColumn("text")
  id!: string;

  @Column("text")
  accountId!: string;

  @Column("text")
  providerId!: string;

  @Column("text")
  userId!: string;

  @Column("text", { nullable: true })
  accessToken!: string | null;

  @Column("text", { nullable: true })
  refreshToken!: string | null;

  @Column("text", { nullable: true })
  idToken!: string | null;

  @Column("timestamptz", { nullable: true })
  accessTokenExpiresAt!: Date | null;

  @Column("timestamptz", { nullable: true })
  refreshTokenExpiresAt!: Date | null;

  @Column("text", { nullable: true })
  scope!: string | null;

  @Column("text", { nullable: true })
  password!: string | null;

  @Column("timestamptz", { default: () => "CURRENT_TIMESTAMP" })
  createdAt!: Date;

  @Column("timestamptz", { default: () => "CURRENT_TIMESTAMP" })
  updatedAt!: Date;
}

@Entity({ name: "verification" })
class PerfVerification {
  @PrimaryColumn("text")
  id!: string;

  @Column("text")
  identifier!: string;

  @Column("text")
  value!: string;

  @Column("timestamptz")
  expiresAt!: Date;

  @Column("timestamptz", { default: () => "CURRENT_TIMESTAMP" })
  createdAt!: Date;

  @Column("timestamptz", { default: () => "CURRENT_TIMESTAMP" })
  updatedAt!: Date;
}

const dataSource = new DataSource({
  type: "postgres",
  host: process.env.POSTGRES_HOST ?? "127.0.0.1",
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  username: process.env.POSTGRES_USER ?? "postgres",
  password: process.env.POSTGRES_PASSWORD ?? "postgres",
  database: process.env.POSTGRES_DATABASE ?? "better_auth_test",
  entities: [PerfUser, PerfSession, PerfAccount, PerfVerification],
  synchronize: true,
  logging: false,
});

const auth = betterAuth({
  baseURL: "http://localhost:3000",
  secret: "test-secret-better-auth-typeorm-issue-32",
  database: typeormAdapter(dataSource, {
    debugLogs: false,
  }),
  emailAndPassword: {
    enabled: true,
  },
});

let rawQueries: string[] = [];
let getTableCalls = 0;

function installCounters() {
  const originalCreateQueryRunner = dataSource.createQueryRunner.bind(dataSource);
  (dataSource as unknown as Record<string, unknown>).createQueryRunner = (
    ...args: Parameters<DataSource["createQueryRunner"]>
  ): QueryRunner => {
    const runner = originalCreateQueryRunner(...args);

    const originalQuery = runner.query.bind(runner);
    runner.query = async (query: string, parameters?: unknown[], useStructuredResult?: boolean) => {
      rawQueries.push(query);
      return originalQuery(query, parameters, useStructuredResult);
    };

    const originalGetTable = runner.getTable.bind(runner);
    runner.getTable = (async (...getTableArgs: Parameters<QueryRunner["getTable"]>) => {
      getTableCalls += 1;
      return await originalGetTable(...getTableArgs);
    }) as QueryRunner["getTable"];

    return runner;
  };
}

function resetCounters() {
  rawQueries = [];
  getTableCalls = 0;
}

function isIntrospectionQuery(query: string): boolean {
  const q = query.toLowerCase();
  return (
    q.includes("information_schema") ||
    q.includes("pg_catalog") ||
    q.includes("pg_class") ||
    q.includes("current_schema()") ||
    q.includes("current_database()") ||
    q.includes("obj_description")
  );
}

let counter = 0;
function uniqueVerification() {
  counter += 1;
  return {
    identifier: `perf-${Date.now()}-${counter}`,
    value: `value-${counter}`,
    expiresAt: new Date(Date.now() + 60_000),
  };
}

beforeAll(async () => {
  if (!dataSource.isInitialized) {
    await dataSource.initialize();
  }
  // NOTE: `synchronize(false)` without drop — this suite shares the `public`
  // schema of the same database with `postgres.test.ts` running in parallel,
  // so a dropping sync would wipe the other suite's tables mid-run.
  await dataSource.synchronize(false);
  installCounters();
}, 60_000);

afterAll(async () => {
  if (dataSource.isInitialized) {
    await dataSource.destroy();
  }
});

describe("issue #32: create avoids per-insert table introspection", () => {
  test("repeated creates do not call getTable() again", async () => {
    const { adapter } = await auth.$context;

    await adapter.create({ model: "verification", data: uniqueVerification() });

    resetCounters();
    await adapter.create({ model: "verification", data: uniqueVerification() });

    expect(getTableCalls).toBe(0);
  });

  test("a steady-state create issues no catalog queries (INSERT + SELECT only)", async () => {
    const { adapter } = await auth.$context;

    await adapter.create({ model: "verification", data: uniqueVerification() });

    resetCounters();
    await adapter.create({ model: "verification", data: uniqueVerification() });

    const introspection = rawQueries.filter(isIntrospectionQuery);
    expect(
      introspection,
      `expected no introspection queries, got: ${JSON.stringify(introspection)}`,
    ).toHaveLength(0);

    expect(rawQueries.length).toBeLessThanOrEqual(3);
  });

  test("end-to-end sign-up still works after warm-up", async () => {
    const email = `perf-${Date.now()}@test.com`;
    const res = await auth.api.signUpEmail({
      body: { email, password: "password123", name: "Perf User" },
    });
    expect(res.user.email).toBe(email);
  });
});

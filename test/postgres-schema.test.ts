import "reflect-metadata";
import { betterAuth } from "better-auth";
import { Column, DataSource, Entity, PrimaryColumn } from "typeorm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { typeormAdapter } from "../package/src";

const SCHEMA = "auth_admin";

@Entity({ name: "user", schema: SCHEMA })
class SchemaUser {
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

@Entity({ name: "session", schema: SCHEMA })
class SchemaSession {
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

@Entity({ name: "account", schema: SCHEMA })
class SchemaAccount {
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

@Entity({ name: "verification", schema: SCHEMA })
class SchemaVerification {
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
  entities: [SchemaUser, SchemaSession, SchemaAccount, SchemaVerification],
  synchronize: false,
  logging: false,
});

const auth = betterAuth({
  baseURL: "http://localhost:3000",
  secret: "test-secret-better-auth-typeorm-issue-31",
  database: typeormAdapter(dataSource, {
    debugLogs: false,
  }),
  emailAndPassword: {
    enabled: true,
  },
  user: {
    deleteUser: {
      enabled: true,
    },
  },
});

async function signInAndGetHeaders(email: string, password: string): Promise<Headers> {
  const res = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  const setCookies = res.headers.getSetCookie();
  const cookies = setCookies.map((c) => c.split(";")[0]).join("; ");
  return new Headers({ cookie: cookies });
}

beforeAll(async () => {
  if (!dataSource.isInitialized) {
    await dataSource.initialize();
  }
  await dataSource.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await dataSource.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
  await dataSource.synchronize(false);
}, 60_000);

afterAll(async () => {
  if (dataSource.isInitialized) {
    await dataSource.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await dataSource.destroy();
  }
});

describe("issue #31: raw SQL respects @Entity({ schema })", () => {
  test("entity metadata registers tables outside public", () => {
    for (const tableName of ["user", "session", "account", "verification"]) {
      const meta = dataSource.entityMetadatas.find((m) => m.tableName === tableName);
      expect(meta, `entity metadata for "${tableName}" should exist`).toBeDefined();
      expect(meta?.schema).toBe(SCHEMA);
    }
  });

  test("tables exist and TypeORM itself resolves them", async () => {
    await expect(dataSource.getRepository(SchemaUser).count()).resolves.toBe(0);
  });

  test("signUpEmail creates rows in the custom schema", async () => {
    const res = await auth.api.signUpEmail({
      body: {
        email: "schema@test.com",
        password: "password123",
        name: "Schema User",
      },
    });

    expect(res.user.email).toBe("schema@test.com");

    const rows = await dataSource.query(`SELECT * FROM "${SCHEMA}"."user" WHERE email = $1`, [
      "schema@test.com",
    ]);
    expect(rows).toHaveLength(1);
  });

  test("signInEmail finds the user", async () => {
    const headers = await signInAndGetHeaders("schema@test.com", "password123");
    const session = await auth.api.getSession({ headers });
    expect(session).not.toBeNull();
    expect(session?.user?.email).toBe("schema@test.com");
  });

  test("findMany / update / listSessions hit the custom schema", async () => {
    const headers = await signInAndGetHeaders("schema@test.com", "password123");

    const sessions = await auth.api.listSessions({ headers });
    expect(Array.isArray(sessions)).toBe(true);
    expect(sessions.length).toBeGreaterThan(0);

    const updated = await auth.api.updateUser({
      headers,
      body: { name: "Updated Schema User" },
    });
    expect(updated?.status).toBe(true);

    const session = await auth.api.getSession({ headers });
    expect(session?.user?.name).toBe("Updated Schema User");
  });

  test("deleteUser removes rows from the custom schema", async () => {
    await auth.api.signUpEmail({
      body: {
        email: "schema-delete@test.com",
        password: "password123",
        name: "Delete Me",
      },
    });
    const headers = await signInAndGetHeaders("schema-delete@test.com", "password123");

    await auth.api.deleteUser({
      headers,
      body: { password: "password123" },
    });

    const rows = await dataSource.query(`SELECT * FROM "${SCHEMA}"."user" WHERE email = $1`, [
      "schema-delete@test.com",
    ]);
    expect(rows).toHaveLength(0);
  });
});

import { betterAuth } from "better-auth";
import { organization, twoFactor } from "better-auth/plugins";
import path from "path";
import { DataSource } from "typeorm";
import { typeormAdapter } from "../package/src";

const typeormOutputDir = path.join(__dirname, "typeorm/sqlite");

const dataSource = new DataSource({
  type: "better-sqlite3",
  database: ":memory:",
  migrationsRun: true,
  entities: [path.join(typeormOutputDir, "entities/**/*.ts")],
  migrations: [path.join(typeormOutputDir, "migrations/**/*.ts")],
});

await dataSource.initialize();

export const auth = betterAuth({
  baseURL: "http://localhost:3000",
  secret: "test-secret-better-auth-typeorm-1234",
  database: typeormAdapter(dataSource, {
    outputDir: typeormOutputDir,
  }),
  emailAndPassword: {
    enabled: true,
  },
  user: {
    deleteUser: {
      enabled: true,
    },
  },
  plugins: [organization({ requireEmailVerificationOnInvitation: false }), twoFactor()],
});

export { dataSource };

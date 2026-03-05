import { betterAuth } from "better-auth";
import { organization, twoFactor } from "better-auth/plugins";
import path from "path";
import { DataSource } from "typeorm";
import { typeormAdapter } from "../package/src";

const dataSource = new DataSource({
  type: "sqlite",
  database: ":memory:",
  migrationsRun: true,
  entities: [path.join(__dirname, "typeorm/entities/**/*.ts")],
  migrations: [path.join(__dirname, "typeorm/migrations/**/*.ts")],
});

await dataSource.initialize();

export const auth = betterAuth({
  baseURL: "http://localhost:3000",
  secret: "test-secret-better-auth-typeorm-1234",
  database: typeormAdapter(dataSource),
  emailAndPassword: {
    enabled: true,
  },
  user: {
    deleteUser: {
      enabled: true,
    },
  },
  plugins: [organization(), twoFactor()],
});

export { dataSource };

import { betterAuth } from "better-auth";
import { organization, twoFactor } from "better-auth/plugins";
import path from "path";
import { DataSource } from "typeorm";
import { typeormAdapter } from "../package/src";

const dataSource = new DataSource({
  type: "postgres",
  host: process.env.POSTGRES_HOST ?? "127.0.0.1",
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  username: process.env.POSTGRES_USER ?? "postgres",
  password: process.env.POSTGRES_PASSWORD ?? "postgres",
  database: process.env.POSTGRES_DATABASE ?? "better_auth_test",
  migrationsRun: true,
  entities: [path.join(__dirname, "typeorm/entities/**/*.ts")],
  migrations: [path.join(__dirname, "typeorm/migrations/**/*.ts")],
});

export const auth = betterAuth({
  database: typeormAdapter(dataSource),
  emailAndPassword: {
    enabled: true,
  },
  plugins: [organization(), twoFactor()],
});

export { dataSource };

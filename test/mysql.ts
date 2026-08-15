import { betterAuth } from "better-auth";
import { organization, twoFactor } from "better-auth/plugins";
import path from "path";
import { DataSource } from "typeorm";
import { typeormAdapter } from "../package/src";

const typeormOutputDir = path.join(__dirname, "typeorm/mysql");

const dataSource = new DataSource({
  type: "mysql",
  host: process.env.MYSQL_HOST ?? "127.0.0.1",
  port: Number(process.env.MYSQL_PORT ?? 3306),
  username: process.env.MYSQL_USER ?? "root",
  password: process.env.MYSQL_PASSWORD ?? "root",
  database: process.env.MYSQL_DATABASE ?? "better_auth_test",
  migrationsRun: true,
  entities: [path.join(typeormOutputDir, "entities/**/*.ts")],
  migrations: [path.join(typeormOutputDir, "migrations/**/*.ts")],
});

export const auth = betterAuth({
  database: typeormAdapter(dataSource, {
    outputDir: typeormOutputDir,
  }),
  emailAndPassword: {
    enabled: true,
  },
  plugins: [organization(), twoFactor()],
});

export { dataSource };

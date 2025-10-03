import { DataSource } from "typeorm";
import { betterAuth } from "better-auth";
import { typeormAdapter } from "@hedystia/better-auth-typeorm";
import path from "path";
import { organization } from "better-auth/plugins";
import { twoFactor } from "better-auth/plugins";

const dataSource = new DataSource({
  type: "sqlite",
  database: path.join(__dirname, "./db.sqlite"),
  migrationsRun: true,
  entities: [path.join(__dirname, "typeorm/entities/**/*.ts")],
  migrations: [path.join(__dirname, "typeorm/migrations/**/*.ts")],
});

await dataSource.initialize();

export const auth = betterAuth({
  database: typeormAdapter(dataSource),
  plugins: [organization(), twoFactor()],
});

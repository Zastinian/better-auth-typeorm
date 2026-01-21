import { runAdapterTest } from "better-auth/adapters/test";
import path from "path";
import { DataSource } from "typeorm";
import { describe } from "vitest";
import { typeormAdapter } from "../package/src";

const dataSource = new DataSource({
  type: "sqlite",
  database: ":memory:",
  entities: [path.join(__dirname, "typeorm/entities/**/*.ts")],
  migrations: [path.join(__dirname, "typeorm/migrations/**/*.ts")],
  synchronize: true,
});

await dataSource.initialize();

describe("My Adapter Tests", async () => {
  const adapter = typeormAdapter(dataSource);

  runAdapterTest({
    getAdapter: async (betterAuthOptions = {}) => {
      return adapter(betterAuthOptions);
    },
  });
});

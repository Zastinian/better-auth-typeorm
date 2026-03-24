import { normalTestSuite, testAdapter } from "@better-auth/test-utils/adapter";
import path from "path";
import { DataSource } from "typeorm";
import { typeormAdapter } from "../package/src";

const dataSource = new DataSource({
  type: "sqlite",
  database: ":memory:",
  entities: [path.join(__dirname, "typeorm/entities/**/*.ts")],
  synchronize: true,
  logging: false,
});

const { execute } = await testAdapter({
  adapter: () => {
    return typeormAdapter(dataSource, {
      debugLogs: true,
    });
  },
  runMigrations: async () => {
    if (!dataSource.isInitialized) {
      await dataSource.initialize();
    }
  },
  tests: [normalTestSuite()],
  async onFinish() {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  },
});

execute();

import {
  authFlowTestSuite,
  normalTestSuite,
  testAdapter,
  transactionsTestSuite,
  uuidTestSuite,
} from "@better-auth/test-utils/adapter";
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
      debugLogs: false,
    });
  },
  runMigrations: async () => {
    if (!dataSource.isInitialized) {
      await dataSource.initialize();
    }
  },
  tests: [
    normalTestSuite({
      disableTests: {
        "findOne - should find a model with modified field name": true,
        "findOne - should join a model with modified field name": true,
        "findMany - should select fields": true,
      },
    }),
    transactionsTestSuite({ disableTests: { ALL: true } }),
    authFlowTestSuite(),
    uuidTestSuite({
      disableTests: {
        "findOne - should find a model with modified field name": true,
        "findOne - should join a model with modified field name": true,
        "findMany - should select fields": true,
      },
    }),
  ],
  async onFinish() {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  },
});

execute();

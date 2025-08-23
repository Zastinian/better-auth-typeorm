import {
  type DataSource,
  type FindOptionsWhere,
  type ObjectLiteral,
  LessThan,
  LessThanOrEqual,
  MoreThan,
  MoreThanOrEqual,
  Like,
  Not,
  In,
} from "typeorm";
import { BetterAuthError } from "better-auth";
import { getAuthTables, type FieldAttribute } from "better-auth/db";
import type { Adapter, BetterAuthOptions, Where } from "better-auth/types";
import * as fs from "fs";
import * as path from "path";

function withApplyDefault(
  value: unknown,
  field: FieldAttribute,
  action: "create" | "update",
): unknown {
  if (action === "update") {
    return value;
  }
  if (value === undefined || value === null) {
    if (field.defaultValue) {
      if (typeof field.defaultValue === "function") {
        return field.defaultValue();
      }
      return field.defaultValue;
    }
  }
  return value;
}

export const typeormAdapter =
  (dataSource: DataSource) =>
  (options: BetterAuthOptions): Adapter => {
    const schema = getAuthTables(options);

    const createTransform = () => {
      function getField(model: string, field: string): string {
        if (field === "id") {
          return field;
        }
        const modelSchema = schema[model];
        if (!modelSchema) {
          throw new Error(`Model ${model} not found in schema`);
        }
        const f = modelSchema.fields[field];
        return f.fieldName || field;
      }

      function convertOperatorToTypeORM(operator: string, value: unknown) {
        switch (operator) {
          case "eq":
            return value;
          case "ne":
            return Not(value);
          case "gt":
            return MoreThan(value);
          case "lt":
            return LessThan(value);
          case "gte":
            return MoreThanOrEqual(value);
          case "lte":
            return LessThanOrEqual(value);
          case "in":
            return In(value as unknown[]);
          case "contains":
            return Like(`%${value}%`);
          case "starts_with":
            return Like(`${value}%`);
          case "ends_with":
            return Like(`%${value}`);
          default:
            return value;
        }
      }

      function convertWhereToFindOptions(
        model: string,
        where?: Where[],
      ): FindOptionsWhere<ObjectLiteral> {
        if (!where || where.length === 0) return {};

        const findOptions: FindOptionsWhere<ObjectLiteral> = {};

        for (const w of where) {
          const field = getField(model, w.field);

          if (!w.operator || w.operator === "eq") {
            findOptions[field] = w.value;
          } else {
            findOptions[field] = convertOperatorToTypeORM(w.operator, w.value);
          }
        }

        return findOptions;
      }

      function getModelName(model: string): string {
        const modelSchema = schema[model];
        if (!modelSchema) {
          throw new Error(`Model ${model} not found in schema`);
        }
        return modelSchema.modelName;
      }

      const useDatabaseGeneratedId = options?.advanced?.generateId === false;

      return {
        transformInput(
          data: Record<string, unknown>,
          model: string,
          action: "create" | "update",
        ): Record<string, unknown> {
          const transformedData: Record<string, unknown> =
            useDatabaseGeneratedId || action === "update"
              ? {}
              : {
                  id: data.id,
                };

          const modelSchema = schema[model];
          if (!modelSchema) {
            throw new Error(`Model ${model} not found in schema`);
          }

          const fields = modelSchema.fields;
          for (const field in fields) {
            const value = data[field];
            if (value === undefined && (!fields[field].defaultValue || action === "update")) {
              continue;
            }
            transformedData[fields[field].fieldName || field] = withApplyDefault(
              value,
              fields[field],
              action,
            );
          }
          return transformedData;
        },

        transformOutput(
          data: ObjectLiteral | null,
          model: string,
          select: string[] = [],
        ): Record<string, unknown> | null {
          if (!data) return null;

          const transformedData: Record<string, unknown> =
            data.id || data._id
              ? select.length === 0 || select.includes("id")
                ? { id: data.id || data._id }
                : {}
              : {};

          const modelSchema = schema[model];
          if (!modelSchema) {
            throw new Error(`Model ${model} not found in schema`);
          }

          const tableSchema = modelSchema.fields;
          for (const key in tableSchema) {
            if (select.length && !select.includes(key)) {
              continue;
            }
            const field = tableSchema[key];
            if (field) {
              transformedData[key] = data[field.fieldName || key];
            }
          }
          return transformedData;
        },

        convertWhereToFindOptions,
        getModelName,
        getField,
      };
    };

    const { transformInput, transformOutput, convertWhereToFindOptions, getModelName } =
      createTransform();

    return {
      id: "typeorm",
      async create<T extends Record<string, unknown>, R = T>(data: {
        model: string;
        data: T;
        select?: string[];
      }): Promise<R> {
        const { model, data: values, select } = data;
        const transformed = transformInput(values, model, "create");

        const repositoryName = getModelName(model);
        const repository = dataSource.getRepository(repositoryName);

        try {
          const result = await repository.save(transformed);
          return transformOutput(result, model, select) as R;
        } catch (error: unknown) {
          throw new BetterAuthError(
            `Failed to create ${model}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },

      async update<T>(data: {
        model: string;
        where: Where[];
        update: Record<string, unknown>;
        select?: string[];
      }): Promise<T | null> {
        const { model, where, update, select = [] } = data;
        const repositoryName = getModelName(model);
        const repository = dataSource.getRepository(repositoryName);

        try {
          const findOptions = convertWhereToFindOptions(model, where);
          const transformed = transformInput(update, model, "update");

          if (where.length === 1) {
            const updatedRecord = await repository.findOne({
              where: findOptions,
            });

            if (updatedRecord) {
              await repository.update(findOptions, transformed);
              const result = await repository.findOne({
                where: findOptions,
              });
              return transformOutput(result, model, select) as T;
            }
          }

          await repository.update(findOptions, transformed);
          return null;
        } catch (error: unknown) {
          throw new BetterAuthError(
            `Failed to update ${model}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },

      async delete(data: { model: string; where: Where[] }): Promise<void> {
        const { model, where } = data;
        const repositoryName = getModelName(model);
        const repository = dataSource.getRepository(repositoryName);

        try {
          const findOptions = convertWhereToFindOptions(model, where);
          await repository.delete(findOptions);
        } catch (error: unknown) {
          throw new BetterAuthError(
            `Failed to delete ${model}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },

      async findOne<T>(data: {
        model: string;
        where: Where[];
        select?: string[];
      }): Promise<T | null> {
        const { model, where, select } = data;
        const repositoryName = getModelName(model);
        const repository = dataSource.getRepository(repositoryName);

        try {
          const findOptions = convertWhereToFindOptions(model, where);
          const result = await repository.findOne({
            where: findOptions,
            select: select,
          });
          return transformOutput(result, model, select) as T;
        } catch (error: unknown) {
          throw new BetterAuthError(
            `Failed to find ${model}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },

      async findMany<T>(data: {
        model: string;
        where?: Where[];
        limit?: number;
        offset?: number;
        sortBy?: { field: string; direction: "asc" | "desc" };
      }): Promise<T[]> {
        const { model, where, limit, offset, sortBy } = data;
        const repositoryName = getModelName(model);
        const repository = dataSource.getRepository(repositoryName);

        try {
          const findOptions = convertWhereToFindOptions(model, where);

          const result = await repository.find({
            where: findOptions,
            take: limit || 100,
            skip: offset || 0,
            order: sortBy?.field
              ? {
                  [sortBy.field]: sortBy.direction === "desc" ? "DESC" : "ASC",
                }
              : undefined,
          });

          return result.map((r) => transformOutput(r, model)) as T[];
        } catch (error: unknown) {
          throw new BetterAuthError(
            `Failed to find many ${model}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },

      async count(data) {
        const { model, where } = data;
        const repositoryName = getModelName(model);
        const repository = dataSource.getRepository(repositoryName);

        try {
          const findOptions = convertWhereToFindOptions(model, where);
          const result = await repository.count({ where: findOptions });
          return result;
        } catch (error: unknown) {
          throw new BetterAuthError(
            `Failed to count ${model}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },

      async updateMany(data) {
        const { model, where, update } = data;
        const repositoryName = getModelName(model);
        const repository = dataSource.getRepository(repositoryName);

        try {
          const findOptions = convertWhereToFindOptions(model, where);
          const transformed = transformInput(update, model, "update");

          const result = await repository.update(findOptions, transformed);
          return result.affected || 0;
        } catch (error: unknown) {
          throw new BetterAuthError(
            `Failed to update many ${model}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },

      async deleteMany(data) {
        const { model, where } = data;
        const repositoryName = getModelName(model);
        const repository = dataSource.getRepository(repositoryName);

        try {
          const findOptions = convertWhereToFindOptions(model, where);
          const result = await repository.delete(findOptions);
          return result.affected || 0;
        } catch (error: unknown) {
          throw new BetterAuthError(
            `Failed to delete many ${model}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },

      async createSchema(_, file) {
        const typeormPath = path.join(process.cwd(), "typeorm");
        const entitiesPath = path.join(typeormPath, "entities");
        const migrationsPath = path.join(typeormPath, "migrations");

        if (!fs.existsSync(typeormPath)) {
          fs.mkdirSync(typeormPath, { recursive: true });
        }
        if (!fs.existsSync(entitiesPath)) {
          fs.mkdirSync(entitiesPath, { recursive: true });
        }
        if (!fs.existsSync(migrationsPath)) {
          fs.mkdirSync(migrationsPath, { recursive: true });
        }

        const entityContents = {
          User: `import { Column, Entity } from "typeorm";

@Entity("user")
export class User {
  @Column("varchar", { primary: true, name: "id", length: 36 })
  id: string;

  @Column("text", { name: "name", nullable: false })
  name: string;

  @Column("varchar", { name: "email", length: 255, nullable: false })
  email: string;

  @Column("boolean", { name: "emailVerified", default: false })
  emailVerified: boolean;

  @Column("text", { name: "image", nullable: true })
  image: string;

  @Column("datetime", { name: "createdAt", nullable: false, default: () => "CURRENT_TIMESTAMP" })
  createdAt: Date;

  @Column("datetime", { name: "updatedAt", nullable: false, default: () => "CURRENT_TIMESTAMP" })
  updatedAt: Date;
}
`,
          Account: `import { Column, Entity } from "typeorm";

@Entity("account")
export class Account {
  @Column("varchar", { primary: true, name: "id", length: 36 })
  id: string;

  @Column("text", { name: "accountId", nullable: false })
  accountId: string;

  @Column("text", { name: "providerId", nullable: false })
  providerId: string;

  @Column("varchar", { name: "userId", length: 36, nullable: false })
  userId: string;

  @Column("text", { name: "accessToken", nullable: true })
  accessToken: string;

  @Column("text", { name: "refreshToken", nullable: true })
  refreshToken: string;

  @Column("text", { name: "idToken", nullable: true })
  idToken: string;

  @Column("datetime", { name: "accessTokenExpiresAt", nullable: true })
  accessTokenExpiresAt: Date;

  @Column("datetime", { name: "refreshTokenExpiresAt", nullable: true })
  refreshTokenExpiresAt: Date;

  @Column("text", { name: "scope", nullable: true })
  scope: string;

  @Column("text", { name: "password", nullable: true })
  password: string;

  @Column("datetime", { name: "createdAt", nullable: false, default: () => "CURRENT_TIMESTAMP" })
  createdAt: Date;

  @Column("datetime", { name: "updatedAt", nullable: false, default: () => "CURRENT_TIMESTAMP" })
  updatedAt: Date;
}
`,
          Session: `import { Column, Entity } from "typeorm";

@Entity("session")
export class Session {
  @Column("varchar", { primary: true, name: "id", length: 36 })
  id: string;

  @Column("datetime", { name: "expiresAt", nullable: false })
  expiresAt: Date;

  @Column("text", { name: "token", nullable: false })
  token: string;

  @Column("datetime", { name: "createdAt", nullable: false, default: () => "CURRENT_TIMESTAMP" })
  createdAt: Date;

  @Column("datetime", { name: "updatedAt", nullable: false, default: () => "CURRENT_TIMESTAMP" })
  updatedAt: Date;

  @Column("text", { name: "ipAddress", nullable: true })
  ipAddress: string;

  @Column("text", { name: "userAgent", nullable: true })
  userAgent: string;

  @Column("varchar", { name: "userId", length: 36, nullable: false })
  userId: string;
}
`,
          Verification: `import { Column, Entity } from "typeorm";

@Entity("verification")
export class Verification {
  @Column("varchar", { primary: true, name: "id", length: 36 })
  id: string;

  @Column("text", { name: "identifier", nullable: false })
  identifier: string;

  @Column("text", { name: "value", nullable: false })
  value: string;

  @Column("datetime", { name: "expiresAt", nullable: false })
  expiresAt: Date;

  @Column("datetime", { name: "createdAt", nullable: true })
  createdAt: Date;

  @Column("datetime", { name: "updatedAt", nullable: true })
  updatedAt: Date;
}
`,
        };

        const entities = ["User", "Account", "Session", "Verification"];
        for (const entity of entities) {
          const entityPath = path.join(entitiesPath, `${entity}.ts`);
          if (!fs.existsSync(entityPath)) {
            fs.writeFileSync(entityPath, entityContents[entity as keyof typeof entityContents]);
          }
        }

        const migrationContents = {
          User1743030454220: `import { type MigrationInterface, type QueryRunner, Table, TableIndex } from "typeorm";

export class User1743030454220 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: "user",
        columns: [
          {
            name: "id",
            type: "varchar",
            length: "36",
            isPrimary: true,
          },
          { name: "name", type: "text", isNullable: false },
          { name: "email", type: "varchar", length: "255", isNullable: false },
          { name: "emailVerified", type: "boolean", isNullable: false },
          { name: "image", type: "text", isNullable: true },
          { name: "createdAt", type: "datetime", isNullable: false },
          { name: "updatedAt", type: "datetime", isNullable: false },
        ],
      }),
    );

    await queryRunner.createIndex(
      "user",
      new TableIndex({
        name: "IDX_user_email",
        columnNames: ["email"],
        isUnique: true,
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable("user");
  }
}
`,
          Account1743030465550: `import { type MigrationInterface, type QueryRunner, Table, TableForeignKey } from "typeorm";

export class Account1743030465550 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: "account",
        columns: [
          {
            name: "id",
            type: "varchar",
            length: "36",
            isPrimary: true,
          },
          { name: "accountId", type: "text", isNullable: false },
          { name: "providerId", type: "text", isNullable: false },
          { name: "userId", type: "varchar", length: "36", isNullable: false },
          { name: "accessToken", type: "text", isNullable: true },
          { name: "refreshToken", type: "text", isNullable: true },
          { name: "idToken", type: "text", isNullable: true },
          { name: "accessTokenExpiresAt", type: "datetime", isNullable: true },
          { name: "refreshTokenExpiresAt", type: "datetime", isNullable: true },
          { name: "scope", type: "text", isNullable: true },
          { name: "password", type: "text", isNullable: true },
          { name: "createdAt", type: "datetime", isNullable: false },
          { name: "updatedAt", type: "datetime", isNullable: false },
        ],
      }),
    );

    await queryRunner.createForeignKey(
      "account",
      new TableForeignKey({
        name: "FK_account_userId_user_id",
        columnNames: ["userId"],
        referencedColumnNames: ["id"],
        referencedTableName: "user",
        onDelete: "CASCADE",
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable("account");
  }
}
`,
          Verification1743030486793: `import { type MigrationInterface, type QueryRunner, Table } from "typeorm";

export class Verification1743030486793 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: "verification",
        columns: [
          {
            name: "id",
            type: "varchar",
            length: "36",
            isPrimary: true,
          },
          { name: "identifier", type: "text", isNullable: false },
          { name: "value", type: "text", isNullable: false },
          { name: "expiresAt", type: "datetime", isNullable: false },
          { name: "createdAt", type: "datetime", isNullable: true },
          { name: "updatedAt", type: "datetime", isNullable: true },
        ],
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable("verification");
  }
}
`,
          Session1743030537958: `import {
  type MigrationInterface,
  type QueryRunner,
  Table,
  TableForeignKey,
  TableIndex,
} from "typeorm";

export class Session1743030537958 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: "session",
        columns: [
          {
            name: "id",
            type: "varchar",
            length: "36",
            isPrimary: true,
          },
          { name: "expiresAt", type: "datetime", isNullable: false },
          { name: "token", type: "varchar", length: "255" },
          { name: "createdAt", type: "datetime", isNullable: false },
          { name: "updatedAt", type: "datetime", isNullable: false },
          { name: "ipAddress", type: "text", isNullable: true },
          { name: "userAgent", type: "text", isNullable: true },
          { name: "userId", type: "varchar", length: "36", isNullable: false },
        ],
      }),
    );
    await queryRunner.createIndex(
      "session",
      new TableIndex({
        name: "IDX_session_token",
        columnNames: ["token"],
        isUnique: true,
      }),
    );
    await queryRunner.createForeignKey(
      "session",
      new TableForeignKey({
        name: "FK_session_userId_user_id",
        columnNames: ["userId"],
        referencedColumnNames: ["id"],
        referencedTableName: "user",
        onDelete: "CASCADE",
      }),
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable("session");
  }
}
`,
        };

        const migrations = [
          "User1743030454220",
          "Account1743030465550",
          "Verification1743030486793",
          "Session1743030537958",
        ];

        for (const migration of migrations) {
          const migrationPath = path.join(migrationsPath, `${migration}.ts`);
          if (!fs.existsSync(migrationPath)) {
            fs.writeFileSync(
              migrationPath,
              migrationContents[migration as keyof typeof migrationContents],
            );
          }
        }

        return {
          code: `// TypeORM schema files created successfully
// Entities: ${entities.join(", ")}
// Migrations: ${migrations.join(", ")}`,
          path: file || path.join(typeormPath, "schema-info.txt"),
        };
      },
    };
  };

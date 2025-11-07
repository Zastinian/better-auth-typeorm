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
import type { BetterAuthOptions, Where } from "better-auth/types";
import { createAdapterFactory, type DBAdapter } from "better-auth/adapters";
import * as fs from "fs";
import * as path from "path";

type FieldAttribute = {
  type: string | string[];
  required?: boolean;
  unique?: boolean;
  fieldName?: string;
  defaultValue?: unknown | (() => unknown);
};

function mapFieldTypeToTypeORM(
  fieldType: string | string[],
  _: FieldAttribute,
): { type: string; length?: string } {
  const typeStr = Array.isArray(fieldType) ? fieldType[0] || "string" : fieldType;

  switch (typeStr) {
    case "string":
      return { type: "text" };
    case "number":
      return { type: "integer" };
    case "boolean":
      return { type: "boolean" };
    case "date":
      return { type: "date" };
    default:
      return { type: "text" };
  }
}

function convertOperatorToTypeORM(operator: Where["operator"], value: unknown) {
  switch (operator) {
    case "ne":
      return Not(value);
    case "lt":
      return LessThan(value);
    case "lte":
      return LessThanOrEqual(value);
    case "gt":
      return MoreThan(value);
    case "gte":
      return MoreThanOrEqual(value);
    case "in":
      return In(value as unknown[]);
    case "not_in":
      return Not(In(value as unknown[]));
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

function generateEntity(
  modelName: string,
  modelSchema: {
    modelName: string;
    fields: Record<string, FieldAttribute>;
    disableMigrations?: boolean;
    order?: number;
  },
): string {
  const className = modelName.charAt(0).toUpperCase() + modelName.slice(1);
  const tableName = modelSchema.modelName;

  const imports = "import { Column, Entity, PrimaryColumn } from 'typeorm';\n\n";
  let entityCode = `@Entity('${tableName}')\nexport class ${className} {\n`;

  entityCode += "  @PrimaryColumn('text')\n";
  entityCode += "  id!: string;\n\n";

  for (const [fieldName, field] of Object.entries(modelSchema.fields)) {
    const fieldAttr = field as FieldAttribute;
    const dbField = fieldAttr.fieldName || fieldName;
    const typeInfo = mapFieldTypeToTypeORM(fieldAttr.type, fieldAttr);

    const columnOptions: string[] = [];

    columnOptions.push(`name: '${dbField}'`);

    if (!fieldAttr.required) {
      columnOptions.push("nullable: true");
    }

    if (fieldAttr.unique || dbField === "email" || dbField === "token") {
      columnOptions.push("unique: true");
    }

    const columnOptionsStr = columnOptions.length > 0 ? `, { ${columnOptions.join(", ")} }` : "";

    entityCode += `  @Column('${typeInfo.type}'${columnOptionsStr})\n`;
    const tsType =
      fieldAttr.type === "date" ? "Date" : fieldAttr.type === "boolean" ? "boolean" : "string";
    const nullableModifier = fieldAttr.required ? "!" : "";
    const nullableType = fieldAttr.required ? "" : " | null";
    entityCode += `  ${fieldName}${nullableModifier}: ${tsType}${nullableType};\n\n`;
  }

  entityCode += "}";

  return imports + entityCode;
}

function generateMigration(
  modelName: string,
  modelSchema: {
    modelName: string;
    fields: Record<string, FieldAttribute>;
    disableMigrations?: boolean;
    order?: number;
  },
  timestamp: number,
  action: "create" | "alter",
  changes?: {
    addColumns?: { name: string; field: FieldAttribute }[];
    dropColumns?: string[];
    modifyColumns?: { name: string; field: FieldAttribute }[];
  },
): string {
  const className = `${action.charAt(0).toUpperCase() + action.slice(1)}${modelName.charAt(0).toUpperCase() + modelName.slice(1)}${timestamp}`;
  const tableName = modelSchema.modelName;

  let migrationCode =
    "import { type MigrationInterface, type QueryRunner, Table, TableIndex, TableColumn } from 'typeorm';\n\n";
  migrationCode += `export class ${className} implements MigrationInterface {\n`;
  migrationCode += "  public async up(queryRunner: QueryRunner): Promise<void> {\n";

  if (action === "create") {
    migrationCode += "    await queryRunner.createTable(\n";
    migrationCode += "      new Table({\n";
    migrationCode += `        name: '${tableName}',\n`;
    migrationCode += "        columns: [\n";

    const columns: string[] = [];
    const indexes: string[] = [];

    columns.push(`          {
            name: 'id',
            type: 'text',
            isPrimary: true,
          }`);

    for (const [fieldName, field] of Object.entries(modelSchema.fields)) {
      const fieldAttr = field as FieldAttribute;
      const dbField = fieldAttr.fieldName || fieldName;
      const typeInfo = mapFieldTypeToTypeORM(fieldAttr.type, fieldAttr);

      if (fieldName === "id" || dbField === "id") {
        continue;
      }

      let columnDef = "          {\n";
      columnDef += `            name: '${dbField}',\n`;
      columnDef += `            type: '${typeInfo.type}',\n`;

      if (typeInfo.length) {
        columnDef += `            length: '${typeInfo.length}',\n`;
      }

      if (!fieldAttr.required) {
        columnDef += "            isNullable: true,\n";
      }

      columnDef += "          }";
      columns.push(columnDef);

      if (fieldAttr.unique || dbField === "email") {
        indexes.push(`    await queryRunner.createIndex(
      '${tableName}',
      new TableIndex({
        name: 'IDX_${tableName}_${dbField}',
        columnNames: ['${dbField}'],
        isUnique: true,
      }),
    );`);
      }
    }

    migrationCode += `${columns.join(",\n")}\n`;
    migrationCode += "        ],\n";
    migrationCode += "      }),\n";
    migrationCode += "    );\n\n";

    if (indexes.length > 0) {
      migrationCode += `${indexes.join("\n\n")}\n`;
    }
  } else if (action === "alter" && changes) {
    if (changes.addColumns && changes.addColumns.length > 0) {
      for (const { name, field } of changes.addColumns) {
        const typeInfo = mapFieldTypeToTypeORM(field.type, field);
        migrationCode += `    await queryRunner.addColumn('${tableName}', new TableColumn({\n`;
        migrationCode += `      name: '${field.fieldName || name}',\n`;
        migrationCode += `      type: '${typeInfo.type}',\n`;
        migrationCode += `      isNullable: ${!field.required},\n`;
        if (field.unique) {
          migrationCode += "      isUnique: true,\n";
        }
        migrationCode += "    }));\n\n";
      }
    }

    if (changes.dropColumns && changes.dropColumns.length > 0) {
      for (const columnName of changes.dropColumns) {
        migrationCode += `    await queryRunner.dropColumn('${tableName}', '${columnName}');\n\n`;
      }
    }

    if (changes.modifyColumns && changes.modifyColumns.length > 0) {
      for (const { name, field } of changes.modifyColumns) {
        const typeInfo = mapFieldTypeToTypeORM(field.type, field);
        migrationCode += `    await queryRunner.changeColumn('${tableName}', '${name}', new TableColumn({\n`;
        migrationCode += `      name: '${field.fieldName || name}',\n`;
        migrationCode += `      type: '${typeInfo.type}',\n`;
        migrationCode += `      isNullable: ${!field.required},\n`;
        if (field.unique) {
          migrationCode += "      isUnique: true,\n";
        }
        migrationCode += "    }));\n\n";
      }
    }
  }

  migrationCode += "  }\n\n";
  migrationCode += "  public async down(queryRunner: QueryRunner): Promise<void> {\n";

  if (action === "create") {
    migrationCode += `    await queryRunner.dropTable('${tableName}');\n`;
  } else if (action === "alter" && changes) {
    if (changes.addColumns && changes.addColumns.length > 0) {
      for (const { name, field } of changes.addColumns) {
        migrationCode += `    await queryRunner.dropColumn('${tableName}', '${field.fieldName || name}');\n`;
      }
    }
    if (changes.dropColumns && changes.dropColumns.length > 0) {
      for (const columnName of changes.dropColumns) {
        migrationCode += `    await queryRunner.addColumn('${tableName}', new TableColumn({ name: '${columnName}', type: 'text', isNullable: true }));\n`;
      }
    }
  }

  migrationCode += "  }\n";
  migrationCode += "}";

  return migrationCode;
}

export const typeormAdapter = (dataSource: DataSource) =>
  createAdapterFactory({
    config: {
      adapterId: "typeorm",
      transaction: async (fn) => {
        const queryRunner = dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
          const manager = queryRunner.manager;

          const convertWhereToFindOptions = (where: Where[]): FindOptionsWhere<ObjectLiteral> => {
            if (!where || where.length === 0) return {};

            const findOptions: FindOptionsWhere<ObjectLiteral> = {};

            for (const w of where) {
              if (!w.operator || w.operator === "eq") {
                findOptions[w.field] = w.value;
              } else {
                findOptions[w.field] = convertOperatorToTypeORM(w.operator, w.value);
              }
            }

            return findOptions;
          };

          const transactionalAdapter: DBAdapter<BetterAuthOptions> = {
            id: "typeorm",
            async create<T extends Record<string, unknown>, R = T>(data: {
              model: string;
              data: Omit<T, "id">;
              select?: string[];
              forceAllowId?: boolean;
            }): Promise<R> {
              const { model, data: values } = data;
              const repository = manager.getRepository(model);
              const entity = repository.create(values as Record<string, unknown>);
              const result = await repository.save(entity);
              return result as R;
            },
            async update<T>(data: {
              model: string;
              where: Where[];
              update: Record<string, unknown>;
            }): Promise<T | null> {
              const { model, where, update } = data;
              const repository = manager.getRepository(model);
              const findOptions = convertWhereToFindOptions(where);

              if (where.length === 1) {
                const updatedRecord = await repository.findOne({ where: findOptions });
                if (updatedRecord) {
                  await repository.update(findOptions, update);
                  const result = await repository.findOne({ where: findOptions });
                  return result as T;
                }
              }

              await repository.update(findOptions, update);
              return null;
            },
            async delete(data): Promise<void> {
              const { model, where } = data;
              const repository = manager.getRepository(model);
              const findOptions = convertWhereToFindOptions(where);
              await repository.delete(findOptions);
            },
            async findOne<T>(data: {
              model: string;
              where: Where[];
              select?: string[];
            }): Promise<T | null> {
              const { model, where, select } = data;
              const repository = manager.getRepository(model);
              const findOptions = convertWhereToFindOptions(where);
              const result = await repository.findOne({ where: findOptions, select });
              return result as T | null;
            },
            async findMany<T>(data: {
              model: string;
              where?: Where[];
              limit?: number;
              offset?: number;
              sortBy?: { field: string; direction: "asc" | "desc" };
            }): Promise<T[]> {
              const { model, where, limit, offset, sortBy } = data;
              const repository = manager.getRepository(model);
              const findOptions = convertWhereToFindOptions(where || []);

              const result = await repository.find({
                where: findOptions,
                take: limit || 100,
                skip: offset || 0,
                order: sortBy?.field
                  ? { [sortBy.field]: sortBy.direction === "desc" ? "DESC" : "ASC" }
                  : undefined,
              });

              return result as T[];
            },
            async count(data): Promise<number> {
              const { model, where } = data;
              const repository = manager.getRepository(model);
              const findOptions = convertWhereToFindOptions(where || []);
              return await repository.count({ where: findOptions });
            },
            async updateMany(data): Promise<number> {
              const { model, where, update } = data;
              const repository = manager.getRepository(model);
              const findOptions = convertWhereToFindOptions(where);
              const result = await repository.update(findOptions, update);
              return result.affected || 0;
            },
            async deleteMany(data): Promise<number> {
              const { model, where } = data;
              const repository = manager.getRepository(model);
              const findOptions = convertWhereToFindOptions(where);
              const result = await repository.delete(findOptions);
              return result.affected || 0;
            },
            transaction: async <TR>(
              callback: (trx: DBAdapter<BetterAuthOptions>) => Promise<TR>,
            ): Promise<TR> => {
              return callback(transactionalAdapter);
            },
          };

          const result = await fn(transactionalAdapter);
          await queryRunner.commitTransaction();
          return result;
        } catch (error) {
          await queryRunner.rollbackTransaction();
          throw error;
        } finally {
          await queryRunner.release();
        }
      },
    },
    adapter: ({
      getModelName,
      getFieldName,
      transformInput,
      transformOutput,
      transformWhereClause,
    }) => {
      function convertWhereToFindOptions(
        model: string,
        where?: Where[],
      ): FindOptionsWhere<ObjectLiteral> {
        if (!where || where.length === 0) return {};

        const cleanedWhere = transformWhereClause({ model, where });
        const findOptions: FindOptionsWhere<ObjectLiteral> = {};

        for (const w of cleanedWhere) {
          const field = getFieldName({ model, field: w.field });

          if (!w.operator || w.operator === "eq") {
            findOptions[field] = w.value;
          } else {
            findOptions[field] = convertOperatorToTypeORM(w.operator, w.value);
          }
        }

        return findOptions;
      }

      return {
        async create<T extends Record<string, unknown>, R = T>(data: {
          model: string;
          data: Omit<T, "id">;
          select?: string[];
          forceAllowId?: boolean;
        }): Promise<R> {
          const { model, data: values, select } = data;
          const transformed = await transformInput(values, model, "create", data.forceAllowId);

          const repositoryName = getModelName(model);
          const repository = dataSource.getRepository(repositoryName);

          try {
            const entity = repository.create(transformed);
            const result = await repository.save(entity);
            const output = await transformOutput(result, model, select);
            return output as R;
          } catch (error: unknown) {
            throw new BetterAuthError(
              `Failed to create ${model}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        },

        async update<T>(data: {
          model: string;
          where: Where[];
          update: T;
        }): Promise<T | null> {
          const { model, where, update } = data;
          const repositoryName = getModelName(model);
          const repository = dataSource.getRepository(repositoryName);

          try {
            const findOptions = convertWhereToFindOptions(model, where);
            const transformed = await transformInput(
              update as Record<string, unknown>,
              model,
              "update",
            );

            if (where.length === 1) {
              const updatedRecord = await repository.findOne({
                where: findOptions,
              });

              if (updatedRecord) {
                await repository.update(findOptions, transformed);
                const result = await repository.findOne({
                  where: findOptions,
                });
                if (result) {
                  const output = await transformOutput(result, model);
                  return output as T;
                }
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
            if (result) {
              const output = await transformOutput(result, model, select);
              return output as T;
            }
            return null;
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

            const transformed = await Promise.all(result.map((r) => transformOutput(r, model)));
            return transformed as T[];
          } catch (error: unknown) {
            throw new BetterAuthError(
              `Failed to find many ${model}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        },

        async count(data: { model: string; where?: Where[] }): Promise<number> {
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

        async updateMany(data: {
          model: string;
          where: Where[];
          update: Record<string, unknown>;
        }): Promise<number> {
          const { model, where, update } = data;
          const repositoryName = getModelName(model);
          const repository = dataSource.getRepository(repositoryName);

          try {
            const findOptions = convertWhereToFindOptions(model, where);
            const transformed = await transformInput(update, model, "update");

            const result = await repository.update(findOptions, transformed);
            return result.affected || 0;
          } catch (error: unknown) {
            throw new BetterAuthError(
              `Failed to update many ${model}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        },

        async deleteMany(data: { model: string; where: Where[] }): Promise<number> {
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

        async createSchema({ tables, file }) {
          try {
            const timestamp = Date.now();
            const typeormDir = path.resolve("./typeorm");
            const migrationsDir = path.resolve("./typeorm/migrations");
            const entitiesDir = path.resolve("./typeorm/entities");

            if (!fs.existsSync(typeormDir)) {
              fs.mkdirSync(typeormDir, { recursive: true });
            }
            if (!fs.existsSync(migrationsDir)) {
              fs.mkdirSync(migrationsDir, { recursive: true });
            }
            if (!fs.existsSync(entitiesDir)) {
              fs.mkdirSync(entitiesDir, { recursive: true });
            }

            const queryRunner = dataSource.createQueryRunner();
            await queryRunner.connect();

            let changelogContent = `# TypeORM Schema Changes - ${new Date().toISOString()}\n\n`;
            let hasChanges = false;

            const expectedTables = Object.keys(tables);

            for (const modelName of expectedTables) {
              const modelSchema = tables[modelName];
              const tableName = modelSchema.modelName;

              const tableExists = await queryRunner.hasTable(tableName);

              const entityCode = generateEntity(modelName, modelSchema);
              const entityPath = path.join(
                entitiesDir,
                `${modelName.charAt(0).toUpperCase() + modelName.slice(1)}.ts`,
              );

              if (!tableExists) {
                const migrationFileName = `${timestamp}-create-${modelName}.ts`;
                const migrationCode = generateMigration(
                  modelName,
                  modelSchema,
                  timestamp,
                  "create",
                );
                const migrationPath = path.join(migrationsDir, migrationFileName);
                fs.writeFileSync(migrationPath, migrationCode);
                fs.writeFileSync(entityPath, entityCode);

                changelogContent += `- CREATE Migration: migrations/${migrationFileName}\n`;
                changelogContent += `- Entity: entities/${modelName.charAt(0).toUpperCase() + modelName.slice(1)}.ts\n\n`;
                hasChanges = true;
              } else {
                const table = await queryRunner.getTable(tableName);
                if (!table) continue;

                const existingColumns = table.columns.map((col) => col.name);
                const expectedFields = modelSchema.fields;

                const addColumns = [];
                const dropColumns = [];

                for (const [fieldName, field] of Object.entries(expectedFields)) {
                  const dbField = field.fieldName || fieldName;
                  if (!existingColumns.includes(dbField)) {
                    addColumns.push({ name: fieldName, field });
                  }
                }

                for (const existingCol of existingColumns) {
                  if (existingCol === "id") continue;
                  const fieldExists = Object.entries(expectedFields).some(
                    ([fieldName, field]) => (field.fieldName || fieldName) === existingCol,
                  );
                  if (!fieldExists) {
                    dropColumns.push(existingCol);
                  }
                }

                if (addColumns.length > 0 || dropColumns.length > 0) {
                  const migrationFileName = `${timestamp}-alter-${modelName}.ts`;
                  const changes = { addColumns, dropColumns, modifyColumns: [] };
                  const migrationCode = generateMigration(
                    modelName,
                    modelSchema,
                    timestamp,
                    "alter",
                    changes,
                  );
                  const migrationPath = path.join(migrationsDir, migrationFileName);
                  fs.writeFileSync(migrationPath, migrationCode);
                  fs.writeFileSync(entityPath, entityCode);

                  changelogContent += `- ALTER Migration: migrations/${migrationFileName}\n`;
                  changelogContent += `- Updated Entity: entities/${modelName.charAt(0).toUpperCase() + modelName.slice(1)}.ts\n`;

                  if (addColumns.length > 0) {
                    changelogContent += `  - Added columns: ${addColumns.map((col) => col.field.fieldName || col.name).join(", ")}\n`;
                  }
                  if (dropColumns.length > 0) {
                    changelogContent += `  - Removed columns: ${dropColumns.join(", ")}\n`;
                  }
                  changelogContent += "\n";
                  hasChanges = true;
                } else {
                  if (fs.existsSync(entityPath)) {
                    const existingContent = fs.readFileSync(entityPath, "utf-8");
                    if (existingContent !== entityCode) {
                      fs.writeFileSync(entityPath, entityCode);
                      changelogContent += `- Updated entity: entities/${modelName.charAt(0).toUpperCase() + modelName.slice(1)}.ts\n\n`;
                      hasChanges = true;
                    }
                  } else {
                    fs.writeFileSync(entityPath, entityCode);
                    changelogContent += `- Generated missing entity: entities/${modelName.charAt(0).toUpperCase() + modelName.slice(1)}.ts\n\n`;
                    hasChanges = true;
                  }
                }
              }
            }

            await queryRunner.release();

            if (!hasChanges) {
              changelogContent += "Schema is up to date. No changes detected.\n";
            }

            return {
              code: changelogContent,
              path: file ?? "typeorm/changelog.txt",
            };
          } catch (error) {
            throw new BetterAuthError(
              `Failed to create schema: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        },
      };
    },
  });

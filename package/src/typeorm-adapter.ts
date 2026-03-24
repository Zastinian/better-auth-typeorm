import { BetterAuthError } from "better-auth";
import { type CleanedWhere, createAdapterFactory } from "better-auth/adapters";
import type { Where } from "better-auth/types";
import * as fs from "fs";
import * as path from "path";
import {
  DataSource,
  type DeleteResult,
  type FindOptionsWhere,
  In,
  LessThan,
  LessThanOrEqual,
  Like,
  MoreThan,
  MoreThanOrEqual,
  Not,
  type ObjectLiteral,
  type Repository,
  type UpdateResult,
} from "typeorm";

type FieldAttribute = {
  type: string | string[];
  required?: boolean;
  unique?: boolean;
  index?: boolean;
  bigint?: boolean;
  fieldName?: string;
  defaultValue?: unknown | (() => unknown);
  onUpdate?: () => unknown;
  references?: {
    model: string;
    field: string;
    onDelete?: "no action" | "restrict" | "cascade" | "set null" | "set default";
  };
};

function toPascalCase(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function toRelationPropertyName(fieldName: string): string {
  if (fieldName.endsWith("Id") && fieldName.length > 2) {
    return fieldName.slice(0, -2);
  }
  return `${fieldName}Relation`;
}

function getDateColumnType(dataSource: DataSource): string {
  switch (dataSource.options.type) {
    case "postgres":
    case "cockroachdb":
      return "timestamptz";
    case "mssql":
      return "datetime2";
    case "mysql":
    case "mariadb":
    case "better-sqlite3":
    case "sqlite":
    case "sqljs":
    case "capacitor":
    case "cordova":
    case "expo":
    case "react-native":
      return "datetime";
    default:
      return "timestamp";
  }
}

function mapFieldTypeToTypeORM(
  fieldType: string | string[],
  field: FieldAttribute,
  dataSource: DataSource,
): { type: string; length?: string } {
  const typeStr = Array.isArray(fieldType) ? fieldType[0] || "string" : fieldType;

  switch (typeStr) {
    case "string":
      return { type: "text" };
    case "number":
      return { type: field.bigint ? "bigint" : "integer" };
    case "boolean":
      return { type: "boolean" };
    case "date":
      return { type: getDateColumnType(dataSource) };
    default:
      return { type: "text" };
  }
}

function formatDefaultValueForEntity(field: FieldAttribute): string | null {
  if (field.defaultValue === undefined) {
    return null;
  }

  if (typeof field.defaultValue === "function") {
    if ((Array.isArray(field.type) ? field.type[0] : field.type) === "date") {
      return "default: () => 'CURRENT_TIMESTAMP'";
    }
    return null;
  }

  if (typeof field.defaultValue === "string") {
    return `default: ${JSON.stringify(field.defaultValue)}`;
  }

  if (typeof field.defaultValue === "number" || typeof field.defaultValue === "boolean") {
    return `default: ${String(field.defaultValue)}`;
  }

  return null;
}

function formatDefaultValueForMigration(field: FieldAttribute): string | null {
  if (field.defaultValue === undefined) {
    return null;
  }

  if (typeof field.defaultValue === "function") {
    if ((Array.isArray(field.type) ? field.type[0] : field.type) === "date") {
      return JSON.stringify("CURRENT_TIMESTAMP");
    }
    return null;
  }

  if (
    typeof field.defaultValue === "string" ||
    typeof field.defaultValue === "number" ||
    typeof field.defaultValue === "boolean"
  ) {
    return JSON.stringify(field.defaultValue);
  }

  return null;
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
  dataSource: DataSource,
  modelName: string,
  modelSchema: {
    modelName: string;
    fields: Record<string, FieldAttribute>;
    disableMigrations?: boolean;
    order?: number;
  },
): string {
  const className = toPascalCase(modelName);
  const tableName = modelSchema.modelName;
  const referencedModels = new Set<string>();
  const typeormImports = new Set(["Column", "Entity", "Index", "PrimaryColumn"]);

  for (const field of Object.values(modelSchema.fields)) {
    if (field.references) {
      referencedModels.add(field.references.model);
      typeormImports.add("JoinColumn");
      typeormImports.add("ManyToOne");
    }
  }

  const imports = [`import { ${Array.from(typeormImports).sort().join(", ")} } from 'typeorm';`];
  for (const referencedModel of Array.from(referencedModels).sort()) {
    imports.push(
      `import { ${toPascalCase(referencedModel)} } from './${toPascalCase(referencedModel)}';`,
    );
  }
  imports.push("");
  let entityCode = `@Entity('${tableName}')\nexport class ${className} {\n`;

  entityCode += "  @PrimaryColumn('text')\n";
  entityCode += "  id!: string;\n\n";

  for (const [fieldName, field] of Object.entries(modelSchema.fields)) {
    const fieldAttr = field as FieldAttribute;
    const dbField = fieldAttr.fieldName || fieldName;
    const typeInfo = mapFieldTypeToTypeORM(fieldAttr.type, fieldAttr, dataSource);

    const columnOptions: string[] = [];

    columnOptions.push(`name: '${dbField}'`);

    if (!fieldAttr.required) {
      columnOptions.push("nullable: true");
    }

    if (fieldAttr.unique || dbField === "email" || dbField === "token") {
      columnOptions.push("unique: true");
    }

    const defaultValue = formatDefaultValueForEntity(fieldAttr);
    if (defaultValue) {
      columnOptions.push(defaultValue);
    }

    const columnOptionsStr = columnOptions.length > 0 ? `, { ${columnOptions.join(", ")} }` : "";

    if (fieldAttr.index) {
      entityCode += `  @Index('${tableName}_${dbField}_idx')\n`;
    }

    entityCode += `  @Column('${typeInfo.type}'${columnOptionsStr})\n`;
    const tsType =
      fieldAttr.type === "date"
        ? "Date"
        : fieldAttr.type === "boolean"
          ? "boolean"
          : fieldAttr.type === "number"
            ? "number"
            : "string";
    const nullableModifier = fieldAttr.required ? "!" : "";
    const nullableType = fieldAttr.required ? "" : " | null";
    entityCode += `  ${fieldName}${nullableModifier}: ${tsType}${nullableType};\n\n`;

    if (fieldAttr.references) {
      const relationClass = toPascalCase(fieldAttr.references.model);
      const relationPropertyName = toRelationPropertyName(fieldName);
      entityCode += `  @ManyToOne(() => ${relationClass}, { onDelete: '${(fieldAttr.references.onDelete || "cascade").toUpperCase()}', nullable: ${fieldAttr.required ? "false" : "true"} })\n`;
      entityCode += `  @JoinColumn({ name: '${dbField}', referencedColumnName: '${fieldAttr.references.field}' })\n`;
      entityCode += `  ${relationPropertyName}${fieldAttr.required ? "!" : "?"}: ${relationClass};\n\n`;
    }
  }

  entityCode += "}";

  return `${imports.join("\n")}\n${entityCode}`;
}

function generateMigration(
  dataSource: DataSource,
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
  const className = `${action.charAt(0).toUpperCase() + action.slice(1)}${toPascalCase(modelName)}${timestamp}`;
  const tableName = modelSchema.modelName;

  let migrationCode =
    "import { type MigrationInterface, type QueryRunner, Table, TableColumn, TableForeignKey, TableIndex } from 'typeorm';\n\n";
  migrationCode += `export class ${className} implements MigrationInterface {\n`;
  migrationCode += "  public async up(queryRunner: QueryRunner): Promise<void> {\n";

  if (action === "create") {
    migrationCode += "    await queryRunner.createTable(\n";
    migrationCode += "      new Table({\n";
    migrationCode += `        name: '${tableName}',\n`;
    migrationCode += "        columns: [\n";

    const columns: string[] = [];
    const postCreateStatements: string[] = [];

    columns.push(`          {
            name: 'id',
            type: 'text',
            isPrimary: true,
          }`);

    for (const [fieldName, field] of Object.entries(modelSchema.fields)) {
      const fieldAttr = field as FieldAttribute;
      const dbField = fieldAttr.fieldName || fieldName;
      const typeInfo = mapFieldTypeToTypeORM(fieldAttr.type, fieldAttr, dataSource);

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

      if (fieldAttr.unique || dbField === "email" || dbField === "token") {
        columnDef += "            isUnique: true,\n";
      }

      const defaultValue = formatDefaultValueForMigration(fieldAttr);
      if (defaultValue) {
        columnDef += `            default: ${defaultValue},\n`;
      }

      columnDef += "          }";
      columns.push(columnDef);

      if (fieldAttr.index) {
        postCreateStatements.push(`    await queryRunner.createIndex(
      '${tableName}',
      new TableIndex({
        name: '${tableName}_${dbField}_idx',
        columnNames: ['${dbField}'],
      }),
    );`);
      }

      if (fieldAttr.references) {
        postCreateStatements.push(`    await queryRunner.createForeignKey(
      '${tableName}',
      new TableForeignKey({
        columnNames: ['${dbField}'],
        referencedTableName: '${fieldAttr.references.model}',
        referencedColumnNames: ['${fieldAttr.references.field}'],
        onDelete: '${(fieldAttr.references.onDelete || "cascade").toUpperCase()}',
      }),
    );`);
      }
    }

    migrationCode += `${columns.join(",\n")}\n`;
    migrationCode += "        ],\n";
    migrationCode += "      }),\n";
    migrationCode += "    );\n\n";

    if (postCreateStatements.length > 0) {
      migrationCode += `${postCreateStatements.join("\n\n")}\n`;
    }
  } else if (action === "alter" && changes) {
    if (changes.addColumns && changes.addColumns.length > 0) {
      for (const { name, field } of changes.addColumns) {
        const typeInfo = mapFieldTypeToTypeORM(field.type, field, dataSource);
        migrationCode += `    await queryRunner.addColumn('${tableName}', new TableColumn({\n`;
        migrationCode += `      name: '${field.fieldName || name}',\n`;
        migrationCode += `      type: '${typeInfo.type}',\n`;
        migrationCode += `      isNullable: ${!field.required},\n`;
        if (
          field.unique ||
          (field.fieldName || name) === "email" ||
          (field.fieldName || name) === "token"
        ) {
          migrationCode += "      isUnique: true,\n";
        }
        const defaultValue = formatDefaultValueForMigration(field);
        if (defaultValue) {
          migrationCode += `      default: ${defaultValue},\n`;
        }
        migrationCode += "    }));\n\n";
        if (field.index) {
          const dbField = field.fieldName || name;
          migrationCode += `    await queryRunner.createIndex('${tableName}', new TableIndex({ name: '${tableName}_${dbField}_idx', columnNames: ['${dbField}'] }));\n\n`;
        }
        if (field.references) {
          const dbField = field.fieldName || name;
          migrationCode += `    await queryRunner.createForeignKey('${tableName}', new TableForeignKey({ columnNames: ['${dbField}'], referencedTableName: '${field.references.model}', referencedColumnNames: ['${field.references.field}'], onDelete: '${(field.references.onDelete || "cascade").toUpperCase()}' }));\n\n`;
        }
      }
    }

    if (changes.dropColumns && changes.dropColumns.length > 0) {
      for (const columnName of changes.dropColumns) {
        migrationCode += `    await queryRunner.dropColumn('${tableName}', '${columnName}');\n\n`;
      }
    }

    if (changes.modifyColumns && changes.modifyColumns.length > 0) {
      for (const { name, field } of changes.modifyColumns) {
        const typeInfo = mapFieldTypeToTypeORM(field.type, field, dataSource);
        migrationCode += `    await queryRunner.changeColumn('${tableName}', '${name}', new TableColumn({\n`;
        migrationCode += `      name: '${field.fieldName || name}',\n`;
        migrationCode += `      type: '${typeInfo.type}',\n`;
        migrationCode += `      isNullable: ${!field.required},\n`;
        if (
          field.unique ||
          (field.fieldName || name) === "email" ||
          (field.fieldName || name) === "token"
        ) {
          migrationCode += "      isUnique: true,\n";
        }
        const defaultValue = formatDefaultValueForMigration(field);
        if (defaultValue) {
          migrationCode += `      default: ${defaultValue},\n`;
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

export interface TypeormAdapterOptions {
  outputDir?: string;
  migrationsDir?: string;
  entitiesDir?: string;
  usePlural?: boolean;
  debugLogs?: boolean;
  softDeleteEnabledEntities?: string[];
}

function createSchemaGenerationDataSource(dataSource: DataSource): DataSource {
  return new DataSource({
    ...dataSource.options,
    entities: [],
    migrations: [],
    subscribers: [],
    migrationsRun: false,
    synchronize: false,
    dropSchema: false,
  });
}

export const typeormAdapter = (dataSource: DataSource, options?: TypeormAdapterOptions) =>
  createAdapterFactory({
    config: {
      adapterId: "typeorm",
      adapterName: "TypeORM",
      usePlural: options?.usePlural ?? false,
      debugLogs: options?.debugLogs ?? false,
      supportsJSON: false,
      supportsDates: true,
      supportsBooleans: true,
      supportsNumericIds: true,
    },
    adapter: ({
      getModelName,
      getDefaultModelName,
      getFieldName,
      transformInput,
      transformOutput,
      transformWhereClause,
    }) => {
      function convertWhereToFindOptions(
        model: string,
        action:
          | "create"
          | "update"
          | "updateMany"
          | "findOne"
          | "findMany"
          | "delete"
          | "deleteMany"
          | "count",
        where?: Where[],
      ): FindOptionsWhere<ObjectLiteral>[] {
        if (!where || where.length === 0) {
          return [{}];
        }

        const cleanedWhere = transformWhereClause({ model, where, action });
        const findOptions: FindOptionsWhere<ObjectLiteral>[] = [];
        let currentGroup: FindOptionsWhere<ObjectLiteral> = {};
        findOptions.push(currentGroup);

        for (const w of cleanedWhere) {
          if (w.connector === "OR") {
            currentGroup = {};
            findOptions.push(currentGroup);
          }
          const field = w.field;
          const value =
            !w.operator || w.operator === "eq"
              ? w.value
              : convertOperatorToTypeORM(w.operator, w.value);

          currentGroup[field] = value;
        }

        return findOptions;
      }
      async function deleteOrSoftDeleteHandler(
        repository: Repository<ObjectLiteral>,
        findOptions: FindOptionsWhere<ObjectLiteral>,
        repositoryName: string,
      ) {
        let result: UpdateResult | DeleteResult;
        if (options?.softDeleteEnabledEntities?.includes(repositoryName)) {
          const hasDeletedAtColumn = repository.metadata.columns.some(
            (column) => column.propertyName === "deletedAt",
          );

          if (!hasDeletedAtColumn) {
            throw new BetterAuthError(`Failed to soft delete. Couldn't locate deletedAt column.`);
          }
          result = await repository.softDelete(findOptions);
        } else {
          result = await repository.delete(findOptions);
        }
        return result;
      }
      return {
        async create({ data, model, select }) {
          if (!dataSource.isInitialized) {
            await dataSource.initialize();
          }
          const defaultModelName = getDefaultModelName(model);
          const transformed = await transformInput(
            data,
            defaultModelName,
            "create",
            data.forceAllowId,
          );

          const repositoryName = getModelName(model);
          const repository = dataSource.getRepository(repositoryName);

          try {
            const entityData: Record<string, unknown> = {};
            for (const key of Object.keys(data as object)) {
              const dbField = getFieldName({ model, field: key });
              entityData[key] = transformed[dbField] ?? data[key];
            }
            if (!entityData.id && transformed.id) {
              entityData.id = transformed.id;
            }
            const entity = repository.create(entityData);
            const result = await repository.save(entity);
            const output = await transformOutput(result, defaultModelName, select);
            return output as typeof data;
          } catch (error: unknown) {
            throw new BetterAuthError(
              `Failed to create ${model}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        },

        async update({ model, where, update }) {
          if (!dataSource.isInitialized) {
            await dataSource.initialize();
          }
          const defaultModelName = getDefaultModelName(model);
          const repositoryName = getModelName(model);
          const repository = dataSource.getRepository(repositoryName);

          try {
            const findOptionsArr = convertWhereToFindOptions(model, "update", where);
            const findOptions = findOptionsArr.length === 1 ? findOptionsArr[0] : findOptionsArr;
            const transformed = await transformInput(
              update as Record<string, unknown>,
              defaultModelName,
              "update",
            );

            if (where.length === 1) {
              const updatedRecord = await repository.findOne({
                where: findOptions,
              });

              if (updatedRecord) {
                const entityData: Record<string, unknown> = {};
                for (const key of Object.keys(update as object)) {
                  const dbField = getFieldName({ model, field: key });
                  entityData[key] =
                    transformed[dbField] ?? (update as Record<string, unknown>)[key];
                }
                await repository.update(findOptions, entityData);
                const result = await repository.findOne({
                  where: findOptions,
                });
                if (result) {
                  const output = await transformOutput(result, defaultModelName);
                  return output as typeof update;
                }
              }
            }

            const entityData: Record<string, unknown> = {};
            for (const key of Object.keys(update as object)) {
              const dbField = getFieldName({ model, field: key });
              entityData[key] = transformed[dbField] ?? (update as Record<string, unknown>)[key];
            }
            await repository.update(findOptions, entityData);
            return null;
          } catch (error: unknown) {
            throw new BetterAuthError(
              `Failed to update ${model}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        },

        async delete({ model, where }) {
          if (!dataSource.isInitialized) {
            await dataSource.initialize();
          }
          const repositoryName = getModelName(model);
          const repository = dataSource.getRepository(repositoryName);

          try {
            const findOptionsArr = convertWhereToFindOptions(model, "delete", where);
            const findOptions = findOptionsArr.length === 1 ? findOptionsArr[0] : findOptionsArr;
            await deleteOrSoftDeleteHandler(repository, findOptions, repositoryName);
          } catch (error: unknown) {
            throw new BetterAuthError(
              `Failed to delete ${model}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        },

        async findOne<T>({
          model,
          where,
          select,
        }: {
          model: string;
          where: CleanedWhere[];
          select?: string[] | undefined;
        }): Promise<T | null> {
          if (!dataSource.isInitialized) {
            await dataSource.initialize();
          }
          const defaultModelName = getDefaultModelName(model);
          const repositoryName = getModelName(model);
          const repository = dataSource.getRepository(repositoryName);

          try {
            const findOptions = convertWhereToFindOptions(model, "findOne", where);
            const result = await repository.findOne({
              where: findOptions,
              select: select,
            });
            if (result) {
              const output = await transformOutput(result, defaultModelName, select);
              return output as T;
            }
            return null;
          } catch (error: unknown) {
            throw new BetterAuthError(
              `Failed to find ${model}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        },

        async findMany<T>({
          model,
          where,
          limit,
          sortBy,
          offset,
        }: {
          model: string;
          where?: CleanedWhere[] | undefined;
          limit: number;
          sortBy?:
            | {
                field: string;
                direction: "asc" | "desc";
              }
            | undefined;
          offset?: number | undefined;
        }): Promise<T[]> {
          if (!dataSource.isInitialized) {
            await dataSource.initialize();
          }
          const defaultModelName = getDefaultModelName(model);
          const repositoryName = getModelName(model);
          const repository = dataSource.getRepository(repositoryName);

          try {
            const findOptions = convertWhereToFindOptions(model, "findMany", where);

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

            const transformed = await Promise.all(
              result.map((r) => transformOutput(r, defaultModelName)),
            );
            return transformed as T[];
          } catch (error: unknown) {
            throw new BetterAuthError(
              `Failed to find many ${model}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        },

        async count({ model, where }) {
          if (!dataSource.isInitialized) {
            await dataSource.initialize();
          }
          const repositoryName = getModelName(model);
          const repository = dataSource.getRepository(repositoryName);

          try {
            const findOptions = convertWhereToFindOptions(model, "count", where);
            const result = await repository.count({ where: findOptions });
            return result;
          } catch (error: unknown) {
            throw new BetterAuthError(
              `Failed to count ${model}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        },

        async updateMany({ model, where, update }) {
          if (!dataSource.isInitialized) {
            await dataSource.initialize();
          }
          const defaultModelName = getDefaultModelName(model);
          const repositoryName = getModelName(model);
          const repository = dataSource.getRepository(repositoryName);

          try {
            const findOptionsArr = convertWhereToFindOptions(model, "updateMany", where);
            const findOptions = findOptionsArr.length === 1 ? findOptionsArr[0] : findOptionsArr;
            const transformed = await transformInput(update, defaultModelName, "update");

            const entityData: Record<string, unknown> = {};
            const updateData = update as Record<string, unknown>;
            for (const key of Object.keys(updateData)) {
              const dbField = getFieldName({ model, field: key });
              entityData[key] = transformed[dbField] ?? update[key];
            }
            const result = await repository.update(findOptions, entityData);
            return result.affected || 0;
          } catch (error: unknown) {
            throw new BetterAuthError(
              `Failed to update many ${model}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        },

        async deleteMany({ model, where }) {
          if (!dataSource.isInitialized) {
            await dataSource.initialize();
          }
          const repositoryName = getModelName(model);
          const repository = dataSource.getRepository(repositoryName);

          try {
            const findOptionsArr = convertWhereToFindOptions(model, "deleteMany", where);
            const findOptions = findOptionsArr.length === 1 ? findOptionsArr[0] : findOptionsArr;
            const result = await deleteOrSoftDeleteHandler(repository, findOptions, repositoryName);
            return result.affected || 0;
          } catch (error: unknown) {
            throw new BetterAuthError(
              `Failed to delete many ${model}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        },

        async createSchema({ tables, file }) {
          let schemaDataSource = dataSource;
          let destroySchemaDataSource = false;

          if (!schemaDataSource.isInitialized) {
            schemaDataSource = createSchemaGenerationDataSource(dataSource);
            destroySchemaDataSource = true;
            await schemaDataSource.initialize();
          }
          try {
            const timestamp = Date.now();
            const typeormDir = path.resolve(options?.outputDir ?? "./typeorm");
            const migrationsDir = path.resolve(
              options?.migrationsDir ?? `${options?.outputDir ?? "./typeorm"}/migrations`,
            );
            const entitiesDir = path.resolve(
              options?.entitiesDir ?? `${options?.outputDir ?? "./typeorm"}/entities`,
            );

            if (!fs.existsSync(typeormDir)) {
              fs.mkdirSync(typeormDir, { recursive: true });
            }
            if (!fs.existsSync(migrationsDir)) {
              fs.mkdirSync(migrationsDir, { recursive: true });
            }
            if (!fs.existsSync(entitiesDir)) {
              fs.mkdirSync(entitiesDir, { recursive: true });
            }

            const queryRunner = schemaDataSource.createQueryRunner();
            await queryRunner.connect();

            let changelogContent = `# TypeORM Schema Changes - ${new Date().toISOString()}\n\n`;
            let hasChanges = false;

            const expectedTables = Object.keys(tables);

            for (const modelName of expectedTables) {
              const modelSchema = tables[modelName];
              const tableName = modelSchema.modelName;

              const tableExists = await queryRunner.hasTable(tableName);

              const entityCode = generateEntity(dataSource, modelName, modelSchema);
              const entityPath = path.join(
                entitiesDir,
                `${modelName.charAt(0).toUpperCase() + modelName.slice(1)}.ts`,
              );

              if (!tableExists) {
                const migrationFileName = `${timestamp}-create-${modelName}.ts`;
                const migrationCode = generateMigration(
                  dataSource,
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
                if (!table) {
                  continue;
                }

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
                  if (existingCol === "id") {
                    continue;
                  }
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
                    dataSource,
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
            if (destroySchemaDataSource) {
              await schemaDataSource.destroy();
            }

            if (!hasChanges) {
              changelogContent += "Schema is up to date. No changes detected.\n";
            }

            return {
              code: changelogContent,
              path: file ?? "typeorm/changelog.txt",
            };
          } catch (error) {
            if (destroySchemaDataSource && schemaDataSource.isInitialized) {
              await schemaDataSource.destroy();
            }
            throw new BetterAuthError(
              `Failed to create schema: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        },
      };
    },
  });

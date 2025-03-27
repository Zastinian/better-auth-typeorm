import { type MigrationInterface, type QueryRunner, Table, TableIndex } from "typeorm";

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

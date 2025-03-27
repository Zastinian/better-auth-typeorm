import { type MigrationInterface, type QueryRunner, Table } from "typeorm";

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

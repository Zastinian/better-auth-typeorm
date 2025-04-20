import { Column, Entity } from "typeorm";

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

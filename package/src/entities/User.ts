import { Column, Entity } from "typeorm";

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

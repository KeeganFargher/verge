import { DataSource } from "typeorm";
import { Author, Post, Status } from "./entity";
import config from "../config";

export const AppDataSource = new DataSource({
	...config.database,
	type: "postgres",
	entities: [Author, Post, Status],
	migrations: [`${__dirname}migrations/*.ts`],
});

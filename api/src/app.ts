// For typeorm
import "reflect-metadata";

import express from "express";
import { useContainer } from "typeorm";
import Container from "typedi";
import config from "./config";
import { AppDataSource } from "./database";
import apolloServer from "./graphql";

const { port } = config;

const app = express();

const start = async (portNumber: number): Promise<void> => {
	useContainer(Container);

	await AppDataSource.initialize();

	const apolloContext = await apolloServer();
	await apolloContext.start();
	apolloContext.applyMiddleware({ app, path: "/graphql" });

	return new Promise<void>((resolve) => {
		app.listen(portNumber, async () => {
			console.log(`Application listening at port ${portNumber}`);
			resolve();
		});
	});
};

start(port);

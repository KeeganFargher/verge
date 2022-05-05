import express from "express";
import config from "./config";

// For typeorm
import "reflect-metadata";

const { port, database } = config;

const app = express();

const start = async (portNumber: number): Promise<void> => {
	return new Promise<void>((resolve) => {
		app.listen(portNumber, async () => {
			console.log(`Application listening at port ${portNumber}`);
			resolve();
		});
	});
};

start(port);

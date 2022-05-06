/* eslint-disable class-methods-use-this */
import { Resolver, Query } from "type-graphql";
import { Service } from "typedi";
import { Status } from "../../../../database/entity";

@Resolver()
@Service()
export default class GetStatusesResolver {
	@Query(() => [Status], { description: "List of Statuses" })
	async statuses(): Promise<Status[]> {
		return Status.find();
	}
}

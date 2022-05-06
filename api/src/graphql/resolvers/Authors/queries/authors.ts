/* eslint-disable class-methods-use-this */
import { Resolver, Query } from "type-graphql";
import { Service } from "typedi";
import { Author } from "../../../../database/entity";

@Resolver()
@Service()
export default class GetAuthorsResolver {
	@Query(() => [Author], { description: "List of Authors" })
	async authors(): Promise<Author[]> {
		return Author.find();
	}
}

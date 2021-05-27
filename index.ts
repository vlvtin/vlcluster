import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as readline from "readline";
import { RegistryServer } from "./registry/registry";
import { Cluster } from "./shared/cluster";
import { Daemon } from "./daemon";
import { WorkerServer } from "./worker/worker";
import { Client } from "./client/client";
import { Worker } from "cluster";
import { GatewayServer } from "./gateway/gateway";
import { CLI } from "./cli";
import { Logger } from "./shared/log";
import { DeployClientController } from "./client/controllers/deploy";
import { CreateRegistryController } from "./registry/controllers/create";

export async function main() {
	let parameters = process.argv.slice(2);
	Cluster.rootDirectory = path.resolve(os.homedir(), ".vlcluster");

	if (!fs.existsSync(Cluster.rootDirectory)) {
		fs.mkdirSync(Cluster.rootDirectory);
	}

	try {
		switch (parameters.shift()) {
			case "init": {
				switch (parameters.shift()) {
					case undefined:
					case "client": {
						console.log(`welcome to vlcluster!`);

						await Client.create(
							await CLI.getArgument(["-e", "--email"], "Your email"), 
							await CLI.getArgument(["-h", "--hostname"], "Registry hostname"),
							await CLI.getArgument(["-k", "--key"], "Registry key")
						)

						return process.exit(0);

						break;
					}

					case "registry": {
						const key = await CreateRegistryController.registry(
							await CLI.getArgument(["-n", "--name"], "Registry name")
						);

						console.log(`created registry!\n\nprivate key: ${key}\nStore this key safely!`);
						
						return process.exit(0);
					}

					case "worker": {
						const registry = await WorkerServer.create(
							await CLI.getArgument(["-h", "--hostname"], "Registry hostname"),
							await CLI.getArgument(["-k", "--key"], "Registry key"),
							await CLI.getArgument(["-n", "--name"], "Worker name")
						);
						
						console.log(`created worker!\n\nwelcome to '${registry.name}'!`);
						return process.exit(0);
					}

					case "endpoint": {
						await new WorkerServer(
							await CLI.getClusterName()
						).setLocalPath(
							await CLI.getArgument(["-h", "--hostname"], "Endpoint hostname")
						);

						console.log(`local path assigned`);
						return process.exit(0);
					}

					case "gateway": {
						await GatewayServer.create(
							await CLI.getArgument(["--cluster-hostname"], "Cluster hostname"),
							await CLI.getArgument(["--cluster-key"], "Cluster key"),
							await CLI.getArgument(["-n", "--name"], "Gateway name"),
							await CLI.getArgument(["--endpoint-hostname"], "Endpoint host")
						);

						console.log(`gateway created`);
						return process.exit(0);
					}

					default: {
						console.error("invalid init command");
						return process.exit(1);
					}
				}

				break;
			}

			case "build": {
				await DeployClientController.build(await CLI.getArgument([1, "-p", "--project-path"]) || ".");

				return process.exit(0);
			}

			case "push": {
				await new Client(
					await CLI.getClusterName()
				).deploy.push(
					await CLI.getArgument([1, "-a", "--application"], "Application name"),
					await CLI.getArgument([2, "-v", "--version"], "Application version")
				);

				return process.exit(0);
			}

			case "upgrade": {
				await new Client(
					await CLI.getClusterName()
				).deploy.upgrade(
					await CLI.getArgument([1, "-a", "--application"], "Application name"),
					await CLI.getArgument([2, "-v", "--version"], "Application version"),
					await CLI.getArgument([3, "-e", "--env"], "Environnement")
				);

				return process.exit(0);
			}

			case "deploy": {
				await new Client(
					await CLI.getClusterName()
				).deploy.deploy(
					await CLI.getArgument([2, "-p", "--project-path"]) || ".", 
					await CLI.getArgument([1, "-e", "--env"], "Environnement"),
				);

				return process.exit(0);
			}

			case "var": {
				switch (parameters.shift()) {
					case "set": {
						await new Client(
							await CLI.getClusterName()
						).variables.set(
							await CLI.getArgument([2, "-n", "--name"], "Variable name"),
							await CLI.getArgument([3, "-v", "--value"], "Variable name"),
							await CLI.getArgument(["-a", "--application"], ["Application", "*", "all applications", null]),
							await CLI.getArgument(["-e", "--env"], ["Environnement", "*", "all envs", null]),
						);
		
						return process.exit(0);
					}

					case "list": {
						const vars = await new Client(
							await CLI.getClusterName()
						).variables.list(
							await CLI.getArgument(["-a", "--application"], ["Application", "*", "all applications", null]),
							await CLI.getArgument(["-e", "--env"], ["Environnement", "*", "all envs", null]),
						);

						new Logger("var list").table(vars);
		
						return process.exit(0);
					}
				}
			}

			case "instance": {
				switch (parameters.shift()) {
					case "list": {
						new Logger("instance list").table(await new Client(
							await CLI.getClusterName()
						).instances.list(
							await CLI.getArgument(["-a", "--application"], ["Application", "*", "all applications", null]),
							await CLI.getArgument(["-e", "--env"], ["Environnement", "*", "all envs", null]),
						));

						return process.exit();
					}

					default: {
						console.error("invalid instance command");
						return process.exit(1);
					}
				}
			}

			case "map": {
				switch (parameters.shift()) {
					// vlcluster map domain <cluster> <host> <port> <application> <env>
					case "domain": {
						await new Client(
							await CLI.getClusterName()
						).map.domain(
							await CLI.getArgument(["-h", "--host"], "Host"),
							+await CLI.getArgument(["-p", "--port"], "Port (default 80)"),
							await CLI.getArgument(["-a", "--application"], "Application"),
							await CLI.getArgument(["-e", "--env"], "Environnement"),
						);
		
						return process.exit(0);
					}

					// vlcluster map websocket <cluster> <host> <port> <path>
					case "websocket": {
						await new Client(
							await CLI.getClusterName()
						).map.webSocket(
							await CLI.getArgument(["-h", "--host"], "Host"),
							+await CLI.getArgument(["-p", "--port"], "Port (default 80)"),
							await CLI.getArgument(["-l", "--location"], "Location (example: /socket)"),
						);

						return process.exit(0);
					}

					default: {
						console.error("invalid map command");
						return process.exit(1);
					}
				}
			}

			case "ssl": {
				switch (parameters.shift()) {
					case "enable": {
						await new Client(
							await CLI.getClusterName()
						).ssl.enable(
							await CLI.getArgument(["-h", "--host"], "Host"),
							+await CLI.getArgument(["-p", "--port"], "Port (default 443)"),
						);

						return process.exit(0);
					}

					default: {
						console.error("invalid ssl command");

						return process.exit(1);
					}
				}
			}

			case "daemon": {
				const daemon = new Daemon();
				daemon.start();

				break;
			}

			default: {
				console.error("invalid command");
				return process.exit(1);
			}
		}
	} catch (e) {
		process.stderr.write(`\x1b[48;5;160m\x1b[38;5;231m${e.message || e}\x1b[0m`);

		process.exit(1);
	}
}
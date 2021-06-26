import * as fs from "fs";
import * as path from "path";

import { spawn } from "child_process";
import { sha512 } from "js-sha512";
import { Cluster } from "../shared/cluster";
import { Logger } from "../shared/log";
import { Request } from "../shared/request";
import { Handler } from "../shared/handler";
import { GatewayConfiguration } from "./configuration";
import { Configuration } from "../shared/configuration";
import { Route } from "./route";

export class GatewayServer {
	logger = new Logger("gateway");

    routes: Route[] = [];

    constructor(public configuration: GatewayConfiguration) {}

    static async create(clusterHost: string, clusterKey: string, name: string, endpointHost: string) {
		const response = await new Request(clusterHost, Cluster.api.registry.create.gateway)
			.append("key", clusterKey)
			.append("name", name)
			.append("host", endpointHost)
			.send<{ key }>();

		Configuration.gateways.push({
			name: name,

			clusterHost: clusterHost,
			clusterKey: clusterKey,

			endpointHost: endpointHost
		});

		Configuration.save();
	}

    register(app) {
        app.post(Cluster.api.gateway.reload, async (req, res) => {
            const key = req.headers["cluster-key"];

            if (key != this.configuration.clusterKey) {
                return res.sendStatus(500);
            }

            this.routes = req.body;

            await this.reloadServer();

            res.json({});
		});

		new Handler(app, Cluster.api.gateway.ssl, async params => {
			const host = params.host;
			const port = params.port;

			this.logger.log("stopping nginx to obtain ssl certificate for ", this.logger.hp(host, port));
			await this.stopNginxDaemon();

			this.logger.log("obtaining ssl for ", this.logger.hp(host, port));

			const process = spawn("certbot", [
				"--standalone", // using standalone webserver for challenge
				"-d", host, // obtain for domain
				"certonly" // only obtain cert, we match domain on our own
			], {
				stdio: "inherit"
			});

			await new Promise(done => {
				process.on("exit", async () => {
					this.logger.log("obtained ssl for ", this.logger.hp(host, port), ". starting nginx");
					await this.startNginxDaemon();

					done(null);
				});
			});
		});
    }

	async startNginxDaemon() {
		return await this.manageNginxDaemon("start");
	}

	async stopNginxDaemon() {
		return await this.manageNginxDaemon("stop");
	}

	async manageNginxDaemon(action: "start" | "stop") {
		const process = spawn("service", ["nginx", action]);

		await new Promise(done => {
			process.on("exit", () => {
				done(null);
			});
		});
	}

    async reloadServer() {
		let configuration = "## AUTO GENERATED\n## DO NOT EDIT THIS FILE\n\n".repeat(10);

        this.logger.log("updating routes...");

        for (let route of this.routes) {
			this.logger.log(
				"routing ", 
				this.logger.hp(route.host, route.port), 
				" → ", 
				this.logger.ae(route.application, route.env), 
				` (${route.ssl ? "SSL, " : ""}${route.instances.length} instances [${
					route.instances.map(i => this.logger.hp(i.endpoint, i.port)).join(", ")
				}]${route.sockets.length ? `, ${route.sockets.length} websockets` : ""})`
			);

            // create upstream
            const upstream = `stream_${sha512(JSON.stringify(route))}`;
			configuration += `# upstreams for ${route.application}[${route.env}]:\nupstream ${upstream} {`;
            
            // add instances
            for (let instance of route.instances) {
                configuration += `\n\tserver ${instance.endpoint}:${instance.port}; # upstream to instance ${instance.name} on ${instance.worker}`;
            }
			
			// create proxy to upstream
			configuration += `\n}\n\n# ${route.ssl ? "ssl protected " : ""}server for ${route.application}[${route.env}]\nserver {\n\tlisten ${route.ssl ? `${route.ssl} ssl` : route.port};\n\tserver_name ${route.host};`;

			if (route.ssl) {
				// ssl config from https://ssl-config.mozilla.org/
				configuration += `\n\n\t# ssl configuration`
				configuration += `\n\tssl_certificate ${GatewayServer.letsencryptFullchain(route.host)};`;
				configuration += `\n\tssl_certificate_key ${GatewayServer.letsencryptPrivateKey(route.host)};`;
				configuration += `\n\tssl_session_cache shared:vlcluster_ssl:10m;`;
				configuration += `\n\tssl_session_timeout 1d;`;
				configuration += `\n\tssl_session_tickets off;`;
				configuration += `\n\tssl_protocols TLSv1.3;`;
				configuration += `\n\tssl_prefer_server_ciphers off;`;
			}

            for (let socket of route.sockets) {
                configuration += `\n\n\t# socket proxy\n\tlocation ${socket} {\n\t\tproxy_pass http://${upstream};\n\t\tproxy_http_version 1.1;\n\t\tproxy_set_header Upgrade $http_upgrade;\n\t\tproxy_set_header Connection "Upgrade";\n\t\t\n\t\t# disable socket timeout\n\t\tproxy_connect_timeout 7d;\n\t\tproxy_send_timeout 7d;\n\t\tproxy_read_timeout 7d;\n\t}`;
			}

			configuration += `\n\n\t# custom include file (will not be overwritten)\n\tinclude ${GatewayServer.nginxIncludeFile(this.configuration.name)};\n\n\t# default proxy\n\tlocation / {\n\t\tproxy_pass http://${upstream};\n\t}\n}\n\n`;
			
			if (route.ssl) {
				configuration += `# http to https upgrade for ${route.application}[${route.env}]\nserver {\n\tlisten ${route.port};\n\tserver_name ${route.host};\n\treturn 301 https://$host$request_uri;\n}\n\n`;
			}
        }

		fs.writeFileSync(GatewayServer.nginxFile(this.configuration.name), configuration);
		
		if (!fs.existsSync(GatewayServer.nginxIncludeFile(this.configuration.name))) {
			fs.writeFileSync(GatewayServer.nginxIncludeFile(this.configuration.name), "# Include File\n# Add custom error handlers here\n# This file will not be overwritten!");
		}

        this.logger.log("reloading proxy server...");

        await new Promise<void>(done => {
            const reloadProcess = spawn("nginx", ["-s", "reload"]);

            reloadProcess.on("exit", () => {
                this.logger.log("routes updated");

                done();
            });
        });
    }

	static nginxFile(name: string) {
		return "/" + path.join("etc", "nginx", "sites-enabled", name);
	}

	static nginxIncludeFile(name: string) {
		return "/" + path.join("etc", "nginx", "snippets", `${name}.include`);
	}

	static letsencryptRoot(host: string) {
		return path.join("/etc/letsencrypt/live/", host);
	}

	static letsencryptFullchain(host: string) {
		return path.join(this.letsencryptRoot(host), "fullchain.pem");
	}

	static letsencryptPrivateKey(host: string) {
		return path.join(this.letsencryptRoot(host), "privkey.pem");
	}
}
const amqp = require('amqplib');

const { RABBITMQ_HOST, RABBITMQ_PORT, RABBITMQ_USER, RABBITMQ_PASS } = process.env;
const url = `amqp://${RABBITMQ_USER}:${RABBITMQ_PASS}@${RABBITMQ_HOST}:${RABBITMQ_PORT}`;
const exchange = 'picturas';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const nextDelay = delay => Math.min(delay * 2, 10_000);

function createRabbitClient(connect = () => amqp.connect(url), wait = sleep) {
    let publisher;

    async function openChannel(onDisconnect, setup, confirm = false) {
        const connection = await connect();
        let disconnected = false;
        const disconnect = (error) => {
            if (disconnected) return;
            disconnected = true;
            if (error) console.error('[rabbitmq]', error.message);
            onDisconnect();
            void connection.close().catch(() => {});
        };
        connection.on('close', () => disconnect());
        connection.on('error', disconnect);
        try {
            const channel = await (confirm ? connection.createConfirmChannel() : connection.createChannel());
            channel.on('close', () => disconnect());
            channel.on('error', disconnect);
            await setup(channel, disconnect);
            if (disconnected) throw new Error('RabbitMQ disconnected during setup');
            return channel;
        } catch (error) {
            disconnect(error);
            throw error;
        }
    }

    function getPublisher() {
        if (!publisher) {
            const opening = openChannel(() => {
                if (publisher === opening) publisher = undefined;
            }, channel => channel.assertExchange(exchange, 'direct', { durable: true }), true);
            publisher = opening;
            // A connection attempt can fail before there is a connection to emit close.
            void opening.catch(() => {
                if (publisher === opening) publisher = undefined;
            });
        }
        return publisher;
    }

    async function send_rabbit_msg(msg, queue) {
        if (!queue) throw new Error('RabbitMQ routing key is required');
        const body = Buffer.from(JSON.stringify(msg));
        for (let delay = 1_000; ; delay = nextDelay(delay)) {
            try {
                const channel = await getPublisher();
                await new Promise((resolve, reject) => {
                    channel.publish(exchange, queue, body, { persistent: true },
                        error => error ? reject(error) : resolve());
                });
                return;
            } catch (error) {
                console.error('[rabbitmq] publish failed:', error.message);
                await wait(delay);
            }
        }
    }

    function read_rabbit_msg(queue, callback) {
        let delay = 1_000;
        let inFlight = Promise.resolve();
        let generation = 0;

        async function start() {
            const current = ++generation;
            const reconnect = () => {
                if (generation !== current) return;
                generation++;
                const pause = delay;
                delay = Math.min(delay * 2, 5_000);
                void wait(pause).then(start);
            };

            try {
                await openChannel(reconnect, async (channel, disconnect) => {
                    await channel.checkQueue(queue);
                    await channel.prefetch(1);
                    await channel.consume(queue, msg => {
                        if (!msg) {
                            disconnect();
                            return;
                        }
                        // A callback from the previous channel may still be finishing.
                        inFlight = inFlight.then(async () => {
                            if (generation !== current) return;
                            let handled = false;
                            try {
                                await callback(msg);
                                handled = true;
                            } catch (error) {
                                console.error('[rabbitmq] handler failed:', error.message);
                            }
                            if (generation !== current) return;
                            try {
                                if (handled) channel.ack(msg);
                                else channel.nack(msg, false, false);
                            } catch (error) {
                                disconnect(error);
                            }
                        });
                    }, { noAck: false });
                });
                if (generation === current) {
                    delay = 1_000;
                    console.log(`[rabbitmq] consuming ${queue}`);
                }
            } catch {
                reconnect();
            }
        }

        void start();
    }

    return { send_rabbit_msg, read_rabbit_msg };
}

module.exports = { ...createRabbitClient(), createRabbitClient };

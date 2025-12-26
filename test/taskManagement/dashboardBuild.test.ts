import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

const execAsync = promisify(exec);

describe('Dashboard Build Verification', () => {
    it('should build the dashboard successfully', async () => {
        const rootDir = path.resolve(__dirname, '../../');

        // Increase timeout to 60s for build
        const timeout = 60000;

        try {
            const { stdout, stderr } = await execAsync('npm run build --prefix dashboard', {
                cwd: rootDir,
                timeout,
            });

            console.log('Build Output:', stdout);
            if (stderr) {
                console.warn('Build Warnings/Errors:', stderr);
            }

            // If it didn't throw, it succeeded
            expect(true).toBe(true);
        } catch (error: any) {
            console.error('Build Failed:', error.stdout || error.message);
            throw new Error(`Dashboard build failed: ${error.message}\n${error.stdout || ''}`);
        }
    }, 60000); // 60s timeout
});

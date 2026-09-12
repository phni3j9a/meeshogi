#import <UIKit/UIKit.h>

@interface MeeshogiFixtureAppDelegate : UIResponder <UIApplicationDelegate>
@property(nonatomic, strong) UIWindow *window;
@property(nonatomic, assign) BOOL didHandleClipboardRequest;
@end

@implementation MeeshogiFixtureAppDelegate

- (BOOL)application:(UIApplication *)application
    didFinishLaunchingWithOptions:(NSDictionary<UIApplicationLaunchOptionsKey, id> *)launchOptions {
  self.window = [[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];
  UIViewController *controller = [[UIViewController alloc] init];
  controller.view.backgroundColor = UIColor.systemBackgroundColor;
  self.window.rootViewController = controller;
  [self.window makeKeyAndVisible];
  return YES;
}

- (void)failClipboardRequest:(NSString *)message resultPath:(NSString *)resultPath {
  if (resultPath.length > 0) {
    [[NSFileManager defaultManager] removeItemAtPath:resultPath error:NULL];
  }
  NSLog(@"Meeshogi fixture clipboard failed: %@", message);
}

- (void)processClipboardRequestIfPresent {
  NSArray<NSString *> *arguments = NSProcessInfo.processInfo.arguments;
  NSUInteger base64Index = [arguments indexOfObject:@"--clipboard-base64"];
  NSUInteger requestIndex = [arguments indexOfObject:@"--clipboard-request"];
  if (base64Index == NSNotFound && requestIndex == NSNotFound) {
    return;
  }
  if (base64Index == NSNotFound || requestIndex == NSNotFound ||
      base64Index + 1 >= arguments.count || requestIndex + 1 >= arguments.count) {
    [self failClipboardRequest:@"missing clipboard launch arguments" resultPath:nil];
    return;
  }

  NSString *encoded = arguments[base64Index + 1];
  NSString *request = arguments[requestIndex + 1];
  NSUUID *uuid = [[NSUUID alloc] initWithUUIDString:request];
  if (uuid == nil) {
    [self failClipboardRequest:@"clipboard request is not a UUID" resultPath:nil];
    return;
  }

  NSArray<NSString *> *cachePaths =
      NSSearchPathForDirectoriesInDomains(NSCachesDirectory, NSUserDomainMask, YES);
  NSString *cacheDirectory = cachePaths.firstObject;
  if (cacheDirectory.length == 0) {
    [self failClipboardRequest:@"cache directory is unavailable" resultPath:nil];
    return;
  }
  NSError *cacheError = nil;
  if (![[NSFileManager defaultManager] createDirectoryAtPath:cacheDirectory
                                   withIntermediateDirectories:YES
                                                    attributes:nil
                                                         error:&cacheError]) {
    [self failClipboardRequest:
              [NSString stringWithFormat:@"could not create cache directory: %@", cacheError]
                      resultPath:nil];
    return;
  }
  NSString *requestName = uuid.UUIDString.lowercaseString;
  NSString *resultPath =
      [cacheDirectory stringByAppendingPathComponent:
                          [NSString stringWithFormat:@"clipboard-%@.txt", requestName]];
  [[NSFileManager defaultManager] removeItemAtPath:resultPath error:NULL];

  NSData *decodedData = [[NSData alloc] initWithBase64EncodedString:encoded options:0];
  NSString *value = [[NSString alloc] initWithData:decodedData encoding:NSUTF8StringEncoding];
  if (value == nil) {
    [self failClipboardRequest:@"clipboard payload is not valid UTF-8 base64" resultPath:resultPath];
    return;
  }

  UIPasteboard *pasteboard = UIPasteboard.generalPasteboard;
  pasteboard.string = value;
  NSString *roundTrip = pasteboard.string;
  if (roundTrip == nil || ![roundTrip isEqualToString:value]) {
    [self failClipboardRequest:@"UIPasteboard round-trip did not match" resultPath:resultPath];
    return;
  }

  NSError *writeError = nil;
  if (![roundTrip writeToFile:resultPath
                    atomically:YES
                      encoding:NSUTF8StringEncoding
                         error:&writeError]) {
    [self failClipboardRequest:
              [NSString stringWithFormat:@"could not write acknowledgement: %@", writeError]
                      resultPath:resultPath];
    return;
  }
  NSLog(@"Meeshogi fixture clipboard acknowledged request %@", requestName);
}

- (void)applicationDidBecomeActive:(UIApplication *)application {
  (void)application;
  if (self.didHandleClipboardRequest) {
    return;
  }
  self.didHandleClipboardRequest = YES;
  [self processClipboardRequestIfPresent];
}

@end

int main(int argc, char *argv[]) {
  @autoreleasepool {
    return UIApplicationMain(argc, argv, nil, NSStringFromClass(MeeshogiFixtureAppDelegate.class));
  }
}

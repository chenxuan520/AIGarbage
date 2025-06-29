import os
import re
import requests
from datetime import datetime
import shutil

def get_env_vars():
    """获取必要的环境变量"""
    ai_api_url = os.getenv('AI_API_URL')
    ai_api_key = os.getenv('AI_API_KEY')
    ai_model = os.getenv('AI_MODEL')

    if not all([ai_api_url, ai_api_key, ai_model]):
        raise ValueError("缺少必要的环境变量: AI_API_URL, AI_API_KEY, AI_MODEL")

    return ai_api_url, ai_api_key, ai_model

def get_prompt():
    """获取prompt内容"""
    prompt = os.getenv('PROMPT')

    if prompt is None:
        # 从prompt.txt读取
        with open('prompt.txt', 'r') as f:
            prompt = f.read()
    elif re.match(r'^https?://', prompt):
        # 从URL获取
        response = requests.get(prompt)
        response.raise_for_status()
        prompt = response.text
        if not prompt.strip():
            return None

    return prompt

def get_public_prompt():
    """获取public_prompt内容"""
    with open('public_prompt.txt', 'r') as f:
        return f.read()

def call_ai_api(api_url, api_key, model, full_prompt):
    """调用AI API"""
    headers = {
        'Authorization': f'Bearer {api_key}',
        'Content-Type': 'application/json',
        'OpenAI-Organization': 'user'
    }

    data = {
        'model': model,
        'messages': [
            {'role': 'user', 'content': full_prompt}
        ],
        'max_tokens': 2000,
        'temperature': 0.7
    }

    response = requests.post(api_url, headers=headers, json=data)
    response.raise_for_status()

    return response.json()['choices'][0]['message']['content']

def save_blog_post(content):
    """直接保存博客文章到目标目录"""
    # 获取第一行作为标题
    first_line = content.split('\n')[0]
    title = re.sub(r'^#+\s*', '', first_line).strip()

    # 清理特殊字符，使其适合作为文件名
    safe_title = re.sub(r'[\\/:*?"<>|]', '', title)
    safe_title = safe_title.replace(' ', '-')

    # 生成Hexo格式的header
    header = f"""---
title: {title}
date: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}
tags: []
---

"""

    # 生成新文件名和路径
    new_filename = f"{safe_title}.md"
    dest_path = os.path.join('..', 'blog', 'source', '_posts', new_filename)

    # 直接写入最终文件
    with open(dest_path, 'w') as f:
        f.write(header + content)

def main():
    try:
        # 1. 获取环境变量
        ai_api_url, ai_api_key, ai_model = get_env_vars()

        # 2. 获取prompt
        prompt = get_prompt()
        if prompt is None:
            print("跳过生成: 从URL获取的prompt为空")
            return

        # 3. 获取public_prompt并拼接
        public_prompt = get_public_prompt()
        full_prompt = f"{public_prompt}\n\n{prompt}"

        # 4. 调用AI API
        ai_output = call_ai_api(ai_api_url, ai_api_key, ai_model, full_prompt)

        # 5. 直接保存博客文章
        save_blog_post(ai_output)

        print("处理完成!")
    except Exception as e:
        print(f"发生错误: {str(e)}")

if __name__ == '__main__':
    main()
